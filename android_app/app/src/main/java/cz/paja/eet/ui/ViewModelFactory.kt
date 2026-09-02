package cz.paja.eet.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.SettingsRepository

class AppViewModelFactory(
    private val settingsRepository: SettingsRepository,
    private val eetApiClient: EetApiClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T = when (modelClass) {
        PaymentViewModel::class.java -> PaymentViewModel(settingsRepository, eetApiClient) as T
        SettingsViewModel::class.java -> SettingsViewModel(settingsRepository) as T
        else -> throw IllegalArgumentException("Unknown ViewModel class: $modelClass")
    }
}
