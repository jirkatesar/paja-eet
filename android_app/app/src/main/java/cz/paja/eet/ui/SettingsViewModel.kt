package cz.paja.eet.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.paja.eet.data.AppSettings
import cz.paja.eet.data.PaymentPreset
import cz.paja.eet.data.SettingsRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class SettingsViewModel(private val repository: SettingsRepository) : ViewModel() {

    var form: AppSettings by mutableStateOf(AppSettings())
        private set
    var loaded: Boolean by mutableStateOf(false)
        private set
    var justSaved: Boolean by mutableStateOf(false)
        private set

    init {
        viewModelScope.launch {
            form = repository.settingsFlow.first()
            loaded = true
        }
    }

    fun update(transform: (AppSettings) -> AppSettings) {
        form = transform(form)
        justSaved = false
    }

    fun addPreset(description: String, amountCzk: Int) {
        update { it.copy(presets = it.presets + PaymentPreset(description = description, amountCzk = amountCzk)) }
    }

    fun updatePreset(id: String, description: String, amountCzk: Int) {
        update {
            it.copy(
                presets = it.presets.map { preset ->
                    if (preset.id == id) preset.copy(description = description, amountCzk = amountCzk) else preset
                },
            )
        }
    }

    fun removePreset(id: String) {
        update { it.copy(presets = it.presets.filterNot { preset -> preset.id == id }) }
    }

    fun save() {
        viewModelScope.launch {
            repository.save(form)
            justSaved = true
        }
    }
}
