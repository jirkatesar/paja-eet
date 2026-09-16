package cz.paja.eet.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.SettingsRepository
import cz.paja.eet.data.UnpaidOrder
import cz.paja.eet.data.UnpaidOrdersResult
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** What the Nezaplacené screen is showing right now. */
sealed class UnpaidOrdersState {
    data object Loading : UnpaidOrdersState()
    data class Loaded(
        val orders: List<UnpaidOrder>,
        val ttlDays: Int?,
        /** Set while a *refresh* of an already-loaded list is in flight, so the list stays on screen. */
        val refreshing: Boolean = false,
    ) : UnpaidOrdersState()
    data class Failed(val message: String) : UnpaidOrdersState()
}

/**
 * Reads the Worker's list of orders nobody has paid for yet.
 *
 * Deliberately reads the settings once per call rather than holding them: the
 * address and token can be corrected in Nastavení while this screen is only a
 * tap away, and a refresh that kept using the old ones would look like the
 * Worker being down.
 *
 * The list is fetched when the screen is created and on every refresh press; it
 * is not polled. Nothing here is urgent to the second — a bank transfer does not
 * land between two glances — and a till that polls a Worker all day would spend
 * the phone's battery on the one thing that never needs to be immediate.
 */
class UnpaidOrdersViewModel(
    private val settingsRepository: SettingsRepository,
    private val eetApiClient: EetApiClient,
) : ViewModel() {

    var state: UnpaidOrdersState by mutableStateOf(UnpaidOrdersState.Loading)
        private set

    init {
        refresh()
    }

    fun refresh() {
        val loaded = state as? UnpaidOrdersState.Loaded
        // Keeps the list visible while reloading it: blanking the screen on every
        // refresh would make the data look lost rather than being fetched.
        state = loaded?.copy(refreshing = true) ?: UnpaidOrdersState.Loading

        viewModelScope.launch {
            val settings = settingsRepository.settingsFlow.first()
            if (!settings.isEetConfigured) {
                state = UnpaidOrdersState.Failed("EET_URL a EET_TOKEN nejsou v Nastavení vyplněné.")
                return@launch
            }

            state = when (val result = eetApiClient.fetchUnpaidOrders(settings.eetUrl, settings.eetToken)) {
                is UnpaidOrdersResult.Success -> UnpaidOrdersState.Loaded(result.unpaid.orders, result.unpaid.ttlDays)
                is UnpaidOrdersResult.Error -> UnpaidOrdersState.Failed(messageFor(result.message))
            }
        }
    }

    /**
     * The Worker answers machine codes, and two of them are worth a sentence:
     * `not_found` is what an older Worker says to a phone that has been updated
     * first — the app would otherwise report a 404 as a network problem and send
     * somebody looking in the wrong place.
     */
    private fun messageFor(error: String): String = when (error) {
        "unauthorized" -> "Worker nesouhlasí s tokenem. Zkontrolujte EET_TOKEN v Nastavení."
        "not_found" -> "Worker tuhle adresu nezná — běží na ní verze, která umí objednávky vrátit?"
        else -> error
    }
}
