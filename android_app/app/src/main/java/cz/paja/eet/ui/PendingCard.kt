package cz.paja.eet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cz.paja.eet.data.PaymentKind
import cz.paja.eet.data.PendingOperation
import cz.paja.eet.ui.theme.SectionLabel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Sales the Worker has not been told about yet, and a button to try again.
 *
 * Shown only when there is something in it: an empty card saying "nothing here"
 * is one more thing to read past on a screen that is used with a customer
 * waiting.
 *
 * This exists because a failure was previously visible only until the operator
 * started the next sale, and a cash sale that never reached EET is a legal
 * record that has to be made good within 48 hours — not something to lose
 * because the phone was out of signal at the wrong moment.
 */
@Composable
fun PendingCard(
    pending: List<PendingOperation>,
    retrying: Boolean,
    retryResult: String?,
    onRetry: () -> Unit,
) {
    if (pending.isEmpty()) return

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Neodeslané platby", fontWeight = FontWeight.Bold)
                Text(
                    if (pending.size == 1) "Jedna platba se ještě nepodařilo odeslat."
                    else "${pending.size} platby se ještě nepodařilo odeslat.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            pending.forEachIndexed { index, item ->
                if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                PendingRow(item)
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = onRetry,
                    enabled = !retrying,
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
                ) { Text(if (retrying) "Odesílám…" else "Zkusit znovu") }
                retryResult?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

@Composable
private fun PendingRow(item: PendingOperation) {
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
            "${item.amountCzk} Kč — ${if (item.kind == PaymentKind.VOUCHER) "poukaz" else "masáž"}, " +
                if (item.cash) "hotovost" else "převod",
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
        )
        Text("VS ${item.variableSymbol} · ${formatTime(item.createdAt)}", style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (item.lastError != null) {
            Text(
                if (item.attempts > 0) "Pokusů: ${item.attempts} · ${item.lastError}" else item.lastError,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

private fun formatTime(epochMs: Long): String =
    SimpleDateFormat("d. M. H:mm", Locale.getDefault()).format(Date(epochMs))
