package cz.paja.eet.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private val Context.queueStore by preferencesDataStore(name = "pending_operations")

/**
 * A sale the app could not finish sending, kept until it can.
 *
 * Two things go wrong when the phone cannot reach the Worker, and they matter
 * differently: the EET registration of a cash sale is a legal record with a 48h
 * deadline, and the order is what makes the customer's voucher and receipt go
 * out. Neither is lost by being retried — `/report` dedupes on the reference and
 * `/order` answers 409 for a symbol it already holds, so re-sending is safe and
 * the app does not have to remember which half succeeded.
 *
 * [reportReference] is the sale's stable id, reused across every attempt;
 * it is null for a transfer, which the Worker registers from the bank payment
 * itself rather than the app reporting it.
 */
data class PendingOperation(
    val id: String = UUID.randomUUID().toString(),
    val createdAt: Long = System.currentTimeMillis(),
    val attempts: Int = 0,
    val lastError: String? = null,
    val cash: Boolean,
    val amountCzk: Int,
    val variableSymbol: String,
    /** Blank when the customer gave no address — there is then nothing to send. */
    val email: String,
    val kind: PaymentKind,
    val constantSymbol: String?,
    val reportReference: String?,
)

private fun encodeQueue(items: List<PendingOperation>): String {
    val array = JSONArray()
    items.forEach { item ->
        array.put(
            JSONObject().apply {
                put("id", item.id)
                put("createdAt", item.createdAt)
                put("attempts", item.attempts)
                put("lastError", item.lastError ?: JSONObject.NULL)
                put("cash", item.cash)
                put("amountCzk", item.amountCzk)
                put("variableSymbol", item.variableSymbol)
                put("email", item.email)
                put("kind", item.kind.name)
                put("constantSymbol", item.constantSymbol ?: JSONObject.NULL)
                put("reportReference", item.reportReference ?: JSONObject.NULL)
            },
        )
    }
    return array.toString()
}

private fun decodeQueue(raw: String): List<PendingOperation> {
    if (raw.isBlank()) return emptyList()
    return runCatching {
        val array = JSONArray(raw)
        (0 until array.length()).mapNotNull { i ->
            // Per item, not per list: one unreadable entry must not take the
            // whole queue with it — the entries are unpaid sales, and losing
            // them silently is the one thing this file exists to prevent.
            runCatching { decodeItem(array.getJSONObject(i)) }.getOrNull()
        }
    }.getOrDefault(emptyList())
}

private fun decodeItem(obj: JSONObject): PendingOperation =
    PendingOperation(
                id = obj.optString("id").ifEmpty { UUID.randomUUID().toString() },
                createdAt = obj.optLong("createdAt"),
                attempts = obj.optInt("attempts"),
                lastError = if (obj.isNull("lastError")) null else obj.optString("lastError"),
                cash = obj.optBoolean("cash"),
                amountCzk = obj.optInt("amountCzk"),
                variableSymbol = obj.optString("variableSymbol"),
                email = obj.optString("email"),
                // An unknown kind reads as a service: the worse mistake is
                // promising a voucher that will never be sent.
                kind = runCatching { PaymentKind.valueOf(obj.optString("kind")) }.getOrDefault(PaymentKind.SERVICE),
                constantSymbol = if (obj.isNull("constantSymbol")) null else obj.optString("constantSymbol"),
        reportReference = if (obj.isNull("reportReference")) null else obj.optString("reportReference"),
    )

/**
 * The queue, on disk so it survives the app being closed — which is the point:
 * the failures it holds happen precisely when something is wrong with the phone
 * or the network, and that is no time to also lose the record.
 */
class PendingOperationsRepository(private val context: Context) {
    private object Keys {
        val QUEUE = stringPreferencesKey("queue")
    }

    val queueFlow: Flow<List<PendingOperation>> = context.queueStore.data.map { prefs ->
        decodeQueue(prefs[Keys.QUEUE] ?: "")
    }

    /**
     * Adds the sale, or merges it into the one already queued.
     *
     * Both halves of a sale fail independently — the EET registration and the
     * order — and they are reported from two places that run at the same time,
     * so this cannot simply overwrite: whichever arrives second would blank out
     * what the first one knew, and a sale that had lost its address would never
     * get its receipt. Missing pieces are therefore filled in rather than
     * replaced.
     *
     * The variable symbol identifies the sale; the app generates it per sale.
     */
    suspend fun addOrUpdate(item: PendingOperation) {
        context.queueStore.edit { prefs ->
            val current = decodeQueue(prefs[Keys.QUEUE] ?: "")
            val existingIndex = current.indexOfFirst { it.variableSymbol == item.variableSymbol }
            val next =
                if (existingIndex >= 0) {
                    val existing = current[existingIndex]
                    val merged = existing.copy(
                        // Non-blank wins, so a report-only failure cannot erase an
                        // address a failing order call had just recorded.
                        email = if (item.email.isNotBlank()) item.email else existing.email,
                        reportReference = item.reportReference ?: existing.reportReference,
                        constantSymbol = item.constantSymbol ?: existing.constantSymbol,
                        attempts = existing.attempts,
                        lastError = item.lastError ?: existing.lastError,
                    )
                    current.toMutableList().also { it[existingIndex] = merged }
                } else {
                    current + item
                }
            prefs[Keys.QUEUE] = encodeQueue(next)
        }
    }

    /**
     * Removes the sales that went through and refreshes the ones that did not.
     *
     * Deliberately reads the queue *inside* the edit rather than taking the
     * caller's snapshot: a retry round spends seconds on the network, and a sale
     * that fails during it is added by another coroutine. Writing back a
     * snapshot would erase exactly those — the payments made while the phone was
     * already struggling, which are the ones most likely to need the queue.
     */
    suspend fun applyRetryResult(sentIds: Set<String>, stillFailing: List<PendingOperation>) {
        context.queueStore.edit { prefs ->
            val current = decodeQueue(prefs[Keys.QUEUE] ?: "")
            val byId = stillFailing.associateBy { it.id }
            val next = current.filterNot { it.id in sentIds }.map { byId[it.id] ?: it }
            prefs[Keys.QUEUE] = encodeQueue(next)
        }
    }
}
