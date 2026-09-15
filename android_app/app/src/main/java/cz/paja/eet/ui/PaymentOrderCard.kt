package cz.paja.eet.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Progress of the voucher order that goes to the Worker alongside a payment.
 *
 * Shown for every sale — paid by transfer (next to the QR code) and in cash
 * (under the EET result) — because the order means the same thing either way and
 * the two must not drift into telling the operator different stories.
 *
 * [isVoucher] only changes the wording: a voucher sale sends the voucher as well
 * as the receipt, a service sends the receipt alone. Without it the card told
 * everyone a voucher was on its way, including the customer who had just paid
 * for a massage.
 *
 * It is deliberately only ever *informational*: the payment has already been
 * taken or is being taken, so a failure here tells staff to retry or to hand the
 * paperwork over by hand, never that the sale itself went wrong.
 */
@Composable
fun PaymentOrderCard(state: PaymentOrderState) {
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
                Text("Zaznamenávám objednávku…")
            }
        }
        // Nothing on success. The operator sees the payment go through and
        // the customer walks away; a confirmation that everything is fine is
        // one more thing on a screen used with somebody waiting.
        is PaymentOrderState.Recorded -> Unit
        is PaymentOrderState.Failed -> UnsentNotice("Platba nebyla odeslána, odešle se později.")
    }
}
