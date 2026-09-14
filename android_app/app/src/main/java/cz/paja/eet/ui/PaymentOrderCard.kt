package cz.paja.eet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Progress of the voucher order that goes to the Worker alongside a payment.
 *
 * Shared by both ways of selling a voucher — paid by transfer (its outcome is
 * shown next to the QR code) and paid in cash (shown under the EET result) —
 * because the order means the same thing either way and the two must not drift
 * into telling the operator different stories.
 *
 * It is deliberately only ever *informational*: the payment has already been
 * taken or is being taken, so a failure here tells staff to retry or to hand
 * the voucher over by hand, never that the sale itself went wrong.
 */
@Composable
fun PaymentOrderCard(state: PaymentOrderState, onRetry: () -> Unit) {
    when (state) {
        is PaymentOrderState.Idle -> Unit
        is PaymentOrderState.Recording -> Card {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp))
                Text("Zaznamenávám objednávku poukazu…")
            }
        }
        is PaymentOrderState.Recorded -> Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Objednávka zaevidována", fontWeight = FontWeight.Bold)
                Text("Poukaz se pošle na e-mail zákazníka.")
            }
        }
        is PaymentOrderState.Failed -> Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Objednávku se nepodařilo zaevidovat", fontWeight = FontWeight.Bold)
                Text(state.message)
                Text("Poukaz se automaticky nepošle — zkuste to znovu, nebo ho předejte ručně.")
                OutlinedButton(onClick = onRetry) { Text("Zkusit znovu") }
            }
        }
    }
}
