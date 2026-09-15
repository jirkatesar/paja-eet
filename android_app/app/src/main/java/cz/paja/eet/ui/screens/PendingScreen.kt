package cz.paja.eet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cz.paja.eet.data.PaymentKind
import cz.paja.eet.data.PendingOperation
import cz.paja.eet.ui.PajaBottomBar
import cz.paja.eet.ui.Routes
import cz.paja.eet.ui.theme.SectionLabel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Sales the Worker has not been told about yet.
 *
 * A screen of its own rather than a card among the payment controls: this is
 * what someone opens when something is wrong, not something to read past while
 * taking the next customer. It is reached from the menu, whose badge says
 * whether there is anything here at all.
 *
 * It exists because a failure used to be visible only until the next sale was
 * started, and a cash sale that never reached EET is a legal record with a 48h
 * deadline — not something to lose because the phone was out of signal.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PendingScreen(
    pending: List<PendingOperation>,
    retrying: Boolean,
    retryResult: String?,
    onRetry: () -> Unit,
    onNavigate: (String) -> Unit,
) {
    Scaffold(
        topBar = { TopAppBar(title = { Text("Neodeslané platby") }) },
        bottomBar = { PajaBottomBar(Routes.PENDING, pending.size, onNavigate) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (pending.isEmpty()) {
                Text(
                    "Vše je odeslané. Kdyby se některá platba nedostala do EET, objeví se tady a zůstane tu, dokud se neodešle.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                return@Column
            }

            Text(
                if (pending.size == 1) "Jedna platba se ještě nepodařilo odeslat."
                else "${pending.size} platby se ještě nepodařilo odeslat.",
                style = MaterialTheme.typography.bodyMedium,
            )

            pending.forEach { item -> PendingDetail(item) }

            Button(
                onClick = onRetry,
                enabled = !retrying,
                contentPadding = PaddingValues(vertical = 14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (retrying) "Odesílám…" else "Zkusit znovu") }

            retryResult?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            Text(
                "Opakované odeslání je bezpečné: EET i objednávka poznají, že jde o tutéž platbu.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PendingDetail(item: PendingOperation) {
    Card {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                "${item.amountCzk} Kč — ${if (item.kind == PaymentKind.VOUCHER) "poukaz" else "masáž"}",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                "${if (item.cash) "hotovost" else "převod"} · ${formatTime(item.createdAt)}",
                style = SectionLabel,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("Variabilní symbol: ${item.variableSymbol}", style = MaterialTheme.typography.bodyMedium)
            if (item.email.isNotBlank()) {
                Text("E-mail: ${item.email}", style = MaterialTheme.typography.bodyMedium)
            }
            if (item.lastError != null) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Text(
                    if (item.attempts > 0) "Pokusů: ${item.attempts}" else "Zatím bez pokusu o opakování",
                    style = SectionLabel,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(item.lastError, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Normal)
            }
        }
    }
}

private fun formatTime(epochMs: Long): String =
    SimpleDateFormat("d. M. yyyy H:mm", Locale.getDefault()).format(Date(epochMs))
