package cz.paja.eet.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Result of a single best-effort attempt to report a sale to the EET Worker. */
sealed class EetReportResult {
    data class Success(val pok: String) : EetReportResult()
    data object Queued : EetReportResult()
    data class Error(val message: String) : EetReportResult()
}

/** What the order is for: a voucher also gets its PDF, a service only the receipt. */
enum class PaymentKind { VOUCHER, SERVICE }

/**
 * Result of recording a payment order. [AlreadyExists] is not really a failure:
 * the Worker holds a variable symbol exclusively, so a second call for the same
 * symbol means an earlier call for it did get through (a retry after a timeout,
 * or a double tap) — the order exists, which is all the caller wanted.
 */
sealed class PaymentOrderResult {
    data object Recorded : PaymentOrderResult()
    data object AlreadyExists : PaymentOrderResult()
    data class Error(val message: String) : PaymentOrderResult()
}

/** Result of reading the Worker's orders for one day. */
sealed class OrderHistoryResult {
    data class Success(val history: OrderHistory) : OrderHistoryResult()
    data class Error(val message: String) : OrderHistoryResult()
}

/**
 * Talks to the separate EET 2.0 reporting Worker that owns the actual signed
 * submission and its own retry queue — this call is a single best-effort
 * attempt, not a retry loop. `reference` must stay the same across retries of
 * the same sale so the Worker can dedupe instead of double-registering it.
 */
class EetApiClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    suspend fun reportSale(eetUrl: String, eetToken: String, reference: String, amountCzk: Int): EetReportResult =
        withContext(Dispatchers.IO) {
            try {
                val (code, data) = postJson(
                    endpoint = eetUrl.trimEnd('/') + "/report",
                    token = eetToken,
                    body = JSONObject().apply {
                        put("reference", reference)
                        put("amountCzk", amountCzk)
                    },
                )
                when {
                    code == 200 && data.optString("pok").isNotEmpty() -> EetReportResult.Success(data.getString("pok"))
                    code == 202 -> EetReportResult.Queued
                    else -> EetReportResult.Error(data.optString("error").ifEmpty { "HTTP $code" })
                }
            } catch (e: IOException) {
                EetReportResult.Error(e.message ?: "Požadavek na EET selhal")
            }
        }

    /**
     * Records a payment order, so the Worker can e-mail the customer — the
     * receipt, plus the voucher itself when [kind] is VOUCHER. Either right away
     * ([cash], paid at the counter) or as soon as the incoming bank transfer
     * matches.
     *
     * For a transfer, [constantSymbol] must be exactly what the payment QR
     * carries — if the two ever disagreed, the payment would never match the
     * order and nothing would ever be sent. It is left out for cash, where there
     * is no payment to match against.
     */
    suspend fun createOrder(
        eetUrl: String,
        eetToken: String,
        amountCzk: Int,
        variableSymbol: String,
        email: String,
        kind: PaymentKind,
        constantSymbol: String?,
        cash: Boolean,
    ): PaymentOrderResult = withContext(Dispatchers.IO) {
        try {
            val (code, data) = postJson(
                endpoint = eetUrl.trimEnd('/') + "/order",
                token = eetToken,
                body = JSONObject().apply {
                    put("amountCzk", amountCzk)
                    put("variableSymbol", variableSymbol)
                    put("email", email)
                    put("kind", kind.name)
                    put("cash", cash)
                    constantSymbol?.let { put("constantSymbol", it) }
                },
            )
            when (code) {
                201 -> PaymentOrderResult.Recorded
                409 -> PaymentOrderResult.AlreadyExists
                else -> PaymentOrderResult.Error(data.optString("error").ifEmpty { "HTTP $code" })
            }
        } catch (e: IOException) {
            PaymentOrderResult.Error(e.message ?: "Objednávku se nepodařilo odeslat")
        }
    }

    /**
     * Reads every order the Worker has for one day — paid and unpaid alike, which
     * is what makes it a history rather than a list of what is outstanding.
     *
     * [day] is a `YYYY-MM-DD` Prague calendar day: the Worker turns it into the
     * day's UTC range itself, so the phone's own timezone cannot shift which
     * sales belong to which day. Every status is asked for; the screen marks each
     * row with whether it has been paid.
     *
     * Read-only and safe to repeat, so it is also what the refresh button does.
     */
    suspend fun fetchOrderHistory(
        eetUrl: String,
        eetToken: String,
        day: String,
        limit: Int = DEFAULT_HISTORY_LIMIT,
    ): OrderHistoryResult = withContext(Dispatchers.IO) {
        try {
            val (code, data) = getJson(
                endpoint = eetUrl.trimEnd('/') + "/orders?date=$day&status=ALL&limit=$limit",
                token = eetToken,
            )
            if (code != 200) {
                return@withContext OrderHistoryResult.Error(data.optString("error").ifEmpty { "HTTP $code" })
            }
            historyFromResponse(data, day)
        } catch (e: IOException) {
            OrderHistoryResult.Error(e.message ?: "Platby se nepodařilo načíst")
        }
    }

    /** POSTs JSON and hands back the status code plus whatever JSON body came with it. */
    private fun postJson(endpoint: String, token: String, body: JSONObject): Pair<Int, JSONObject> {
        val request = Request.Builder()
            .url(endpoint)
            .header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        return client.newCall(request).execute().use { response ->
            val data = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
            response.code to data
        }
    }

    private fun getJson(endpoint: String, token: String): Pair<Int, JSONObject> {
        val request = Request.Builder()
            .url(endpoint)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        return client.newCall(request).execute().use { response ->
            val data = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
            response.code to data
        }
    }

    private companion object {
        /** A day at a massage till, not an archive: the cap is there to bound the response, not to page. */
        const val DEFAULT_HISTORY_LIMIT = 200
    }
}

/**
 * Reads one field, treating a JSON `null` as absent.
 *
 * `org.json`'s `optString` does **not** do this: on a JSON null it returns
 * `String.valueOf(JSONObject.NULL)`, which is the four-character string
 * `"null"`. Every field the Worker can send as null has to be read through
 * here, or the phone shows the operator the word "null" where a reason should
 * be — which is exactly what the history screen did with `lastError`.
 */
internal fun JSONObject.optTextOrNull(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }

/**
 * Reads a `GET /orders` answer for one day, checking that it really is that day.
 *
 * The Worker echoes back the `date` it applied, and a Worker older than this app
 * ignores the parameter without complaining — it answers with every order it
 * has, which is indistinguishable from a day filter that quietly does nothing.
 * That is a worse failure than an error: the operator reads a day's takings off
 * a list that is not that day's. So a missing or different echo is reported,
 * and the screen says which end needs updating.
 */
internal fun historyFromResponse(data: JSONObject, day: String): OrderHistoryResult {
    if (data.optTextOrNull("date") != day) return OrderHistoryResult.Error(STALE_WORKER)

    val rows = data.optJSONArray("rows") ?: JSONArray()
    // A row that cannot be read is skipped rather than failing the whole list:
    // one malformed order must not hide the others, which are what the operator
    // came here to see.
    val orders = (0 until rows.length()).mapNotNull { index ->
        rows.optJSONObject(index)?.let(::orderRecordFrom)
    }
    return OrderHistoryResult.Success(OrderHistory(orders))
}

/** The Worker does not know `date` — see `historyFromResponse`. */
internal const val STALE_WORKER = "stale_worker"

/**
 * One row of `GET /orders`, as the Worker writes it.
 *
 * An unknown `kind` reads as a service, same as in the retry queue: the worse
 * mistake is promising a voucher that will never arrive. An unrecognised
 * `status` is kept as it came rather than mapped onto a guess — `OrderRecord`
 * is what decides that unknown means "not paid".
 */
internal fun orderRecordFrom(row: JSONObject): OrderRecord? {
    val amountCzk = row.optTextOrNull("amountCzk")?.let(::parseAmountCzk) ?: return null
    return OrderRecord(
        id = row.optLong("id"),
        variableSymbol = row.optTextOrNull("variableSymbol").orEmpty(),
        amountCzk = amountCzk,
        kind = runCatching { PaymentKind.valueOf(row.optTextOrNull("kind").orEmpty()) }.getOrDefault(PaymentKind.SERVICE),
        email = row.optTextOrNull("email").orEmpty(),
        status = row.optTextOrNull("status").orEmpty(),
        createdAt = parseWorkerTimestamp(row.optTextOrNull("createdAt").orEmpty()),
        paidAt = parseWorkerTimestamp(row.optTextOrNull("paidAt").orEmpty()),
        // `matchProblem`, not `lastError`: the column also carries mail delivery
        // failures, and those are the operator's business — the till has no
        // business showing a customer a row about the receipt e-mail.
        matchProblem = row.optTextOrNull("matchProblem"),
    )
}
