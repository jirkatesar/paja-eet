package cz.paja.eet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cz.paja.eet.data.OrderRecord
import cz.paja.eet.data.PaymentKind
import cz.paja.eet.ui.HistoryState
import cz.paja.eet.ui.PajaBottomBar
import cz.paja.eet.ui.Routes
import cz.paja.eet.ui.theme.SectionLabel
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * One day's payments, each with whether it has been paid.
 *
 * The till hands over a QR code or takes the cash and sees no further; whether
 * the money arrived is only known to the Worker, which matches the bank
 * transfers. This is where that half is read back — the day's takings as the
 * books have them, not as the counter remembers them.
 *
 * The day is the day the sale was *made*, not the day the money arrived: a
 * transfer ordered on Monday and paid on Wednesday belongs to Monday, which is
 * also why an outstanding one stays visible on the day it was sold.
 *
 * Read-only. Money arriving is what settles an order, and nothing pressable here
 * would make that happen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(
    day: LocalDate,
    state: HistoryState,
    onDaySelected: (LocalDate) -> Unit,
    onRefresh: () -> Unit,
    pendingCount: Int,
    onNavigate: (String) -> Unit,
) {
    var picking by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Historie") },
                actions = {
                    IconButton(
                        onClick = onRefresh,
                        enabled = state !is HistoryState.Loading && (state as? HistoryState.Loaded)?.refreshing != true,
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Obnovit")
                    }
                },
            )
        },
        bottomBar = { PajaBottomBar(Routes.HISTORY, pendingCount, onNavigate) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            DayFilter(day = day, onChange = { picking = true })

            when (state) {
                is HistoryState.Loading -> LoadingRow()

                is HistoryState.Failed -> {
                    Text("Platby se nepodařilo načíst.", style = MaterialTheme.typography.titleMedium)
                    Text(state.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onRefresh) { Text("Zkusit znovu") }
                }

                is HistoryState.Loaded -> {
                    if (state.refreshing) LoadingRow()
                    if (state.orders.isEmpty()) {
                        Text(
                            "Za tento den tu není žádná platba.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        DaySummary(state.orders)
                        // Oldest first, the way the day happened.
                        state.orders.forEach { order -> OrderCard(order) }
                    }
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            Text(
                "Platba patří do dne, kdy vznikla — převod zaplacený o dva dny později zůstává tady. " +
                    "Hotovost je zaplacená hned, převod čeká, než dorazí peníze.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (picking) {
        DayPickerDialog(
            day = day,
            onDismiss = { picking = false },
            onConfirm = {
                picking = false
                onDaySelected(it)
            },
        )
    }
}

/** The chosen day, and the way to change it. */
@Composable
private fun DayFilter(day: LocalDate, onChange: () -> Unit) {
    Card {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("DEN", style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(formatDay(day), style = MaterialTheme.typography.titleMedium)
            }
            Button(onClick = onChange) { Text("Změnit den") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DayPickerDialog(day: LocalDate, onDismiss: () -> Unit, onConfirm: (LocalDate) -> Unit) {
    // The picker works in UTC-midnight milliseconds, so the selected date comes
    // back the same way — reading it in the phone's own zone would show the
    // previous day for anyone west of Greenwich, and this app's day is Prague's.
    val pickerState = rememberDatePickerState(initialSelectedDateMillis = day.toEpochDay() * MILLIS_PER_DAY)

    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    val millis = pickerState.selectedDateMillis ?: return@TextButton
                    onConfirm(Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate())
                },
            ) { Text("Zobrazit") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušit") } },
    ) {
        DatePicker(state = pickerState)
    }
}

/** What the day adds up to — the question a day view exists to answer. */
@Composable
private fun DaySummary(orders: List<OrderRecord>) {
    val paid = orders.filter { it.isPaid }
    val total = orders.sumOf { it.amountCzk }
    val paidTotal = paid.sumOf { it.amountCzk }

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(paymentCount(orders.size), style = MaterialTheme.typography.bodyMedium)
        Text(
            if (paid.size == orders.size) {
                "Vše zaplaceno — $paidTotal Kč"
            } else {
                // A count of what is left, not a verb to agree with — "zbývá 1"
                // and "zbývají 2" is a distinction the sentence can simply avoid.
                "Zaplaceno $paidTotal Kč z $total Kč · nezaplaceno ${orders.size - paid.size}"
            },
            style = MaterialTheme.typography.titleMedium,
        )
    }
}

/** Czech counts in threes: 1 platba, 2–4 platby, 5+ plateb. */
private fun paymentCount(count: Int): String = when {
    count == 1 -> "1 platba"
    count in 2..4 -> "$count platby"
    else -> "$count plateb"
}

@Composable
private fun OrderCard(order: OrderRecord) {
    Card {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${order.amountCzk} Kč — ${if (order.kind == PaymentKind.VOUCHER) "poukaz" else "masáž"}",
                    style = MaterialTheme.typography.titleMedium,
                )
                order.createdAt?.let {
                    Text(formatTime(it), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            StatusBadge(order)

            Text("Variabilní symbol: ${order.variableSymbol}", style = MaterialTheme.typography.bodyMedium)
            if (order.email.isNotBlank()) {
                Text("E-mail: ${order.email}", style = MaterialTheme.typography.bodyMedium)
            }
            if (order.isPaid) {
                order.paidAt?.let {
                    Text("Zaplaceno ${formatDayTime(it)}", style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            // The one case worth interrupting for: the payment did arrive, but it
            // did not match, so the customer thinks they have paid and the order
            // is still sitting here.
            order.matchProblem?.let { problem ->
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                    Icon(
                        Icons.Filled.WarningAmber,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(20.dp),
                    )
                    Text(
                        problem,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Normal,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusBadge(order: OrderRecord) {
    val paid = order.isPaid
    val container = when {
        paid -> MaterialTheme.colorScheme.primaryContainer
        order.status == "CANCELLED" || order.status == "EXPIRED" -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.secondaryContainer
    }
    val content = if (paid) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant

    Surface(color = container, shape = RoundedCornerShape(50), contentColor = content) {
        Text(
            statusLabel(order),
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
        )
    }
}

/**
 * What the row says about the money. `PAID` and `SENT` are both "paid" — the
 * second only means the receipt has gone out too — and an unrecognised status is
 * shown as it came rather than translated into a claim.
 */
private fun statusLabel(order: OrderRecord): String = when (order.status) {
    "PAID", "SENT" -> "Zaplaceno"
    "PENDING" -> "Nezaplaceno"
    "EXPIRED" -> "Vypršelo"
    "CANCELLED" -> "Zrušeno"
    else -> order.status
}

@Composable
private fun LoadingRow() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp))
        Text("Načítám platby…", style = MaterialTheme.typography.bodyMedium)
    }
}

private const val MILLIS_PER_DAY = 24L * 60 * 60 * 1000

/** Czech on purpose: the whole app is, and the day name is read at a glance. */
private val CZECH: Locale = Locale.forLanguageTag("cs-CZ")

private val DAY_FORMAT = DateTimeFormatter.ofPattern("EEEE d. M. yyyy", CZECH)
private val TIME_FORMAT = DateTimeFormatter.ofPattern("H:mm", CZECH)
private val DAY_TIME_FORMAT = DateTimeFormatter.ofPattern("d. M. yyyy H:mm", CZECH)

private fun formatDay(day: LocalDate): String = day.format(DAY_FORMAT)

/**
 * The Worker's stamps are UTC; both of these show them on the phone's own clock,
 * which is the one the operator took the money by.
 */
private fun formatTime(epochMs: Long): String = atPhone(epochMs).format(TIME_FORMAT)

private fun formatDayTime(epochMs: Long): String = atPhone(epochMs).format(DAY_TIME_FORMAT)

private fun atPhone(epochMs: Long): ZonedDateTime =
    ZonedDateTime.ofInstant(Instant.ofEpochMilli(epochMs), ZoneId.systemDefault())
