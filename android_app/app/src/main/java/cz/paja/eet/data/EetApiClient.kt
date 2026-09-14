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

/**
 * Result of recording a voucher order. [AlreadyExists] is not really a failure:
 * the Worker holds a voucher number exclusively, so a second call for the same
 * number means an earlier call for it did get through (a retry after a timeout,
 * or a double tap) — the order exists, which is all the caller wanted.
 */
sealed class VoucherOrderResult {
    data object Recorded : VoucherOrderResult()
    data object AlreadyExists : VoucherOrderResult()
    data class Error(val message: String) : VoucherOrderResult()
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
     * Records a voucher order, so the Worker can e-mail the voucher to the
     * customer: either right away ([cash], paid at the counter) or as soon as the
     * incoming bank transfer matches.
     *
     * For a transfer, [constantSymbol] must be exactly what the payment QR
     * carries — if the two ever disagreed, the payment would never match the
     * order and the voucher would silently never be sent. It is left out for
     * cash, where there is no payment to match against.
     */
    suspend fun createVoucherOrder(
        eetUrl: String,
        eetToken: String,
        amountCzk: Int,
        variableSymbol: String,
        email: String,
        constantSymbol: String?,
        cash: Boolean,
    ): VoucherOrderResult = withContext(Dispatchers.IO) {
        try {
            val (code, data) = postJson(
                endpoint = eetUrl.trimEnd('/') + "/voucher/order",
                token = eetToken,
                body = JSONObject().apply {
                    put("amountCzk", amountCzk)
                    put("variableSymbol", variableSymbol)
                    put("email", email)
                    put("cash", cash)
                    constantSymbol?.let { put("constantSymbol", it) }
                },
            )
            when (code) {
                201 -> VoucherOrderResult.Recorded
                409 -> VoucherOrderResult.AlreadyExists
                else -> VoucherOrderResult.Error(data.optString("error").ifEmpty { "HTTP $code" })
            }
        } catch (e: IOException) {
            VoucherOrderResult.Error(e.message ?: "Objednávku se nepodařilo odeslat")
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
