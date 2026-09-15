package cz.paja.eet.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private val Context.dataStore by preferencesDataStore(name = "settings")

/** A staff-defined shortcut ("popis" + "částka") shown on the Payment screen. */
data class PaymentPreset(
    val id: String = UUID.randomUUID().toString(),
    val description: String,
    val amountCzk: Int,
)

/** App configuration entered once by staff on the Settings screen. */
data class AppSettings(
    val eetUrl: String = "",
    val eetToken: String = "",
    val bankAccountNumber: String = "",
    val bankCode: String = "",
    val ksServices: String = "",
    val ksVouchers: String = "",
    val presets: List<PaymentPreset> = emptyList(),
    /** How often the app re-sends failed sales while it is running, in minutes. */
    val retryIntervalMinutes: Int = DEFAULT_RETRY_INTERVAL_MINUTES,
) {
    companion object {
        const val DEFAULT_RETRY_INTERVAL_MINUTES = 5
    }

    /** Whether everything needed to take a cash payment (EET report) is filled in. */
    val isEetConfigured: Boolean
        get() = eetUrl.isNotBlank() && eetToken.isNotBlank()

    /** Whether everything needed to render a transfer QR code is filled in. */
    val isBankConfigured: Boolean
        get() = bankAccountNumber.isNotBlank() && bankCode.isNotBlank() && ksServices.isNotBlank() && ksVouchers.isNotBlank()
}

private fun encodePresets(presets: List<PaymentPreset>): String {
    val array = JSONArray()
    presets.forEach { preset ->
        array.put(
            JSONObject().apply {
                put("id", preset.id)
                put("description", preset.description)
                put("amountCzk", preset.amountCzk)
            },
        )
    }
    return array.toString()
}

private fun decodePresets(raw: String): List<PaymentPreset> {
    if (raw.isBlank()) return emptyList()
    return runCatching {
        val array = JSONArray(raw)
        (0 until array.length()).map { i ->
            val obj = array.getJSONObject(i)
            PaymentPreset(
                id = obj.optString("id").ifEmpty { UUID.randomUUID().toString() },
                description = obj.optString("description"),
                amountCzk = obj.optInt("amountCzk"),
            )
        }
    }.getOrDefault(emptyList())
}

class SettingsRepository(private val context: Context) {
    private object Keys {
        val EET_URL = stringPreferencesKey("eet_url")
        val EET_TOKEN = stringPreferencesKey("eet_token")
        val BANK_ACCOUNT_NUMBER = stringPreferencesKey("bank_account_number")
        val BANK_CODE = stringPreferencesKey("bank_code")
        val KS_SERVICES = stringPreferencesKey("ks_services")
        val KS_VOUCHERS = stringPreferencesKey("ks_vouchers")
        val PRESETS = stringPreferencesKey("presets")
        val RETRY_INTERVAL_MINUTES = intPreferencesKey("retry_interval_minutes")
    }

    val settingsFlow: Flow<AppSettings> = context.dataStore.data.map { prefs ->
        AppSettings(
            eetUrl = prefs[Keys.EET_URL] ?: "",
            eetToken = prefs[Keys.EET_TOKEN] ?: "",
            bankAccountNumber = prefs[Keys.BANK_ACCOUNT_NUMBER] ?: "",
            bankCode = prefs[Keys.BANK_CODE] ?: "",
            ksServices = prefs[Keys.KS_SERVICES] ?: "",
            ksVouchers = prefs[Keys.KS_VOUCHERS] ?: "",
            presets = decodePresets(prefs[Keys.PRESETS] ?: ""),
            retryIntervalMinutes = prefs[Keys.RETRY_INTERVAL_MINUTES] ?: AppSettings.DEFAULT_RETRY_INTERVAL_MINUTES,
        )
    }

    suspend fun save(settings: AppSettings) {
        context.dataStore.edit { prefs ->
            prefs[Keys.EET_URL] = settings.eetUrl.trim()
            prefs[Keys.EET_TOKEN] = settings.eetToken.trim()
            prefs[Keys.BANK_ACCOUNT_NUMBER] = settings.bankAccountNumber.trim()
            prefs[Keys.BANK_CODE] = settings.bankCode.trim()
            prefs[Keys.KS_SERVICES] = settings.ksServices.trim()
            prefs[Keys.KS_VOUCHERS] = settings.ksVouchers.trim()
            prefs[Keys.PRESETS] = encodePresets(settings.presets)
            prefs[Keys.RETRY_INTERVAL_MINUTES] = settings.retryIntervalMinutes
        }
    }
}
