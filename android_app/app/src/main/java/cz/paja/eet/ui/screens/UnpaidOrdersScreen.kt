package cz.paja.eet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cz.paja.eet.data.PaymentKind
import cz.paja.eet.data.UnpaidOrder
import cz.paja.eet.data.expiresAt
import cz.paja.eet.ui.PajaBottomBar
import cz.paja.eet.ui.Routes
import cz.paja.eet.ui.UnpaidOrdersState
import cz.paja.eet.ui.theme.SectionLabel
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Date
import java.util.Locale

/**
 * Orders the Worker is holding but nobody has paid for.
 *
 * The till cannot know this on its own: it hands over a QR code and that is the
 * end of what it sees. The Worker is the one matching the incoming bank
 * transfers, so the question "did that customer ever pay?" is only answerable
 * there — and it is worth asking, because an unpaid order stops being usable
 * after a while and its variable symbol goes back into circulation.
 *
 * Read-only on purpose. Money arriving is what settles an order; nothing the
 * operator could press here would make that happen, and a button that cancelled
 * one would be a way to lose a payment that is still on its way.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnpaidOrdersScreen(
    state: UnpaidOrdersState,
    onRefresh: () -> Unit,
    pendingCount: Int,
    onNavigate: (String) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Nezaplacené objednávky") },
                actions = {
                    IconButton(
                        onClick = onRefresh,
                        enabled = state !is UnpaidOrdersState.Loading && (state as? UnpaidOrdersState.Loaded)?.refreshing != true,
                    ) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Obnovit")
                    }
                },
            )
        },
        bottomBar = { PajaBottomBar(Routes.UNPAID, pendingCount, onNavigate) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (state) {
                is UnpaidOrdersState.Loading -> LoadingRow()

                is UnpaidOrdersState.Failed -> {
                    Text(
                        "Objednávky se nepodařilo načíst.",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(state.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onRefresh) { Text("Zkusit znovu") }
                }

                is UnpaidOrdersState.Loaded -> {
                    if (state.refreshing) LoadingRow()
                    if (state.orders.isEmpty()) {
                        Text(
                            "Žádná objednávka nečeká na zaplacení. Všechno, co jste vystavili, je zaplacené.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        Text(
                            if (state.orders.size == 1) "Jedna objednávka ještě čeká na zaplacení."
                            else "${state.orders.size} objednávek čeká na zaplacení.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        // Oldest first, so the first card is the one closest to
                        // running out of time.
                        state.orders.forEach { order -> UnpaidOrderCard(order, state.ttlDays) }
                    }
                }
            }

            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            Text(
                "Objednávka vzniká u platby převodem a zaniká, jakmile dorazí peníze. " +
                    "Nezaplacená se po čase ruší a její variabilní symbol se uvolní pro další prodej. " +
                    "Hotovost se sem nedostane — ta je zaplacená hned.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun LoadingRow() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp))
        Text("Načítám objednávky…", style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun UnpaidOrderCard(order: UnpaidOrder, ttlDays: Int?) {
    Card {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                "${order.amountCzk} Kč — ${if (order.kind == PaymentKind.VOUCHER) "poukaz" else "masáž"}",
                style = MaterialTheme.typography.titleMedium,
            )
            Text("Variabilní symbol: ${order.variableSymbol}", style = MaterialTheme.typography.bodyMedium)
            if (order.email.isNotBlank()) {
                Text("E-mail: ${order.email}", style = MaterialTheme.typography.bodyMedium)
            }

            val created = order.createdAt
            if (created != null) {
                Text("Vytvořeno ${formatDate(created)}", style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            order.expiresAt(ttlDays)?.let { expires ->
                Text(expiryText(expires), style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            // The one case worth interrupting for: the payment did arrive, but it
            // did not match, so the customer thinks they have paid and the order
            // is still sitting here.
            order.matchProblem?.let { problem ->
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Top,
                ) {
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

/**
 * How long the order has left, in the terms a person chasing a payment asks it:
 * the date, and how many days away it is. "Dnes"/"zítra" rather than "za 0 dní".
 */
private fun expiryText(expiresAt: Long): String {
    val date = formatDate(expiresAt)
    val days = daysUntil(expiresAt)
    return when {
        days < 0 -> "Vypršelo $date"
        days == 0L -> "Vyprší dnes"
        days == 1L -> "Vyprší zítra ($date)"
        else -> "Vyprší $date (za $days dní)"
    }
}

private fun daysUntil(epochMs: Long): Long =
    ChronoUnit.DAYS.between(
        LocalDate.now(),
        Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()).toLocalDate(),
    )

private fun formatDate(epochMs: Long): String =
    SimpleDateFormat("d. M. yyyy", Locale.getDefault()).format(Date(epochMs))
