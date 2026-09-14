package cz.paja.eet.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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
}
