package cz.paja.eet.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.OrderHistoryResult
import cz.paja.eet.data.OrderRecord
import cz.paja.eet.data.STALE_WORKER
import cz.paja.eet.data.SettingsRepository
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

/** The days this business counts in — see `BusinessDay`. */
private val PRAGUE: ZoneId = ZoneId.of("Europe/Prague")

/**
 * What "today" means here.
 *
 * The Worker reads the day it is given as a Prague day (`pragueDayRangeUtc`), so
 * the app asks in the same terms rather than in the phone's own timezone. A
 * phone set to UTC — or one that travelled — would otherwise open on a day the
 * business does not agree with, off by two hours' worth of sales at the edges.
 */
object BusinessDay {
    fun today(): LocalDate = LocalDate.now(PRAGUE)

    /** `YYYY-MM-DD`, which is what the Worker's `date` parameter takes. */
    fun format(day: LocalDate): String = day.toString()
}

/** What the Historie screen is showing right now. */
sealed class HistoryState {
    data object Loading : HistoryState()
    data class Loaded(
        val orders: List<OrderRecord>,
        /** Set while a *refresh* of an already-loaded day is in flight, so the list stays on screen. */
        val refreshing: Boolean = false,
    ) : HistoryState()
    data class Failed(val message: String) : HistoryState()
}

/**
 * Reads one day's payments from the Worker.
 *
 * The day is state rather than a call argument: the screen keeps it, the picker
 * changes it, and every load reads the same field. It starts on today, which is
 * what a till wants to see at opening time and after every sale.
 *
 * Deliberately reads the settings once per call rather than holding them: the
 * address and token can be corrected in Nastavení while this screen is a tap
 * away, and a reload that kept using the old ones would look like the Worker
 * being down.
 */
class HistoryViewModel(
    private val settingsRepository: SettingsRepository,
    private val eetApiClient: EetApiClient,
) : ViewModel() {

    var day: LocalDate by mutableStateOf(BusinessDay.today())
        private set

    var state: HistoryState by mutableStateOf(HistoryState.Loading)
        private set

    init {
        load()
    }

    fun onDaySelected(selected: LocalDate) {
        if (selected == day) return
        day = selected
        // The old day's rows have nothing to do with the new one, so they go
        // rather than sitting under a heading that no longer describes them.
        state = HistoryState.Loading
        load()
    }

    fun refresh() = load()

    private fun load() {
        val loaded = state as? HistoryState.Loaded
        // Keeps the list visible while reloading it: blanking the screen on every
        // refresh would make the data look lost rather than being fetched.
        state = loaded?.copy(refreshing = true) ?: HistoryState.Loading
        val requested = day

        viewModelScope.launch {
            val settings = settingsRepository.settingsFlow.first()
            if (!settings.isEetConfigured) {
                state = HistoryState.Failed("EET_URL a EET_TOKEN nejsou v Nastavení vyplněné.")
                return@launch
            }

            val result = eetApiClient.fetchOrderHistory(settings.eetUrl, settings.eetToken, BusinessDay.format(requested))
            // The operator can change the day while a request is in flight; the
            // answer that arrives late is about a day nobody is looking at.
            if (requested != day) return@launch
            state = when (result) {
                is OrderHistoryResult.Success -> HistoryState.Loaded(result.history.orders)
                is OrderHistoryResult.Error -> HistoryState.Failed(messageFor(result.message))
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
        "not_found" -> "Worker tuhle adresu nezná — běží na ní verze, která umí platby vrátit?"
        "invalid_date" -> "Worker odmítl zvolené datum."
        // The Worker answered for a different day than the one asked for, which
        // only an older deployment does — it ignores `date` and returns
        // everything, so the list would look plausible and be wrong.
        STALE_WORKER -> "Worker běží ve starší verzi a filtr dne ještě neumí. Nasaďte novější verzi Workeru."
        else -> error
    }
}
