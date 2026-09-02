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
            val endpoint = eetUrl.trimEnd('/') + "/report"
            val body = JSONObject().apply {
                put("reference", reference)
                put("amountCzk", amountCzk)
            }.toString().toRequestBody("application/json".toMediaType())

            val request = Request.Builder()
                .url(endpoint)
                .header("Authorization", "Bearer $eetToken")
                .post(body)
                .build()

            try {
                client.newCall(request).execute().use { response ->
                    val data = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
                    when {
                        response.code == 200 && data.optString("pok").isNotEmpty() ->
                            EetReportResult.Success(data.getString("pok"))
                        response.code == 202 -> EetReportResult.Queued
                        else -> EetReportResult.Error(
                            data.optString("error").ifEmpty { "HTTP ${response.code}" }
                        )
                    }
                }
            } catch (e: IOException) {
                EetReportResult.Error(e.message ?: "Požadavek na EET selhal")
            }
        }
}
