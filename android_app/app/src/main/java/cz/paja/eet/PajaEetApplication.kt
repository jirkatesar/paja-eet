package cz.paja.eet

import android.app.Application
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.SettingsRepository

class PajaEetApplication : Application() {
    val settingsRepository: SettingsRepository by lazy { SettingsRepository(this) }
    val eetApiClient: EetApiClient by lazy { EetApiClient() }
}
