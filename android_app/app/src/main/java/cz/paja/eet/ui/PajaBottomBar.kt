package cz.paja.eet.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material.icons.filled.ReportProblem
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

/** The three places this app can be. Kept as strings so they match the nav routes. */
object Routes {
    const val PAYMENT = "payment"
    const val PENDING = "pending"
    const val SETTINGS = "settings"
    const val TRANSFER_QR = "transfer_qr"
}

/**
 * The app's menu.
 *
 * Three destinations is where a bar at the bottom earns its place: it is what a
 * thumb reaches without letting go of the phone, and the till is used standing
 * up.
 *
 * The count on "Neodeslané" is the point of the whole screen behind it — a sale
 * that never reached EET is a legal record with a deadline, and a plain menu
 * entry would not say whether anything is waiting there.
 */
@Composable
fun PajaBottomBar(current: String, pendingCount: Int, onSelect: (String) -> Unit) {
    NavigationBar {
        NavigationBarItem(
            selected = current == Routes.PAYMENT,
            onClick = { onSelect(Routes.PAYMENT) },
            icon = { Icon(Icons.Filled.Payments, contentDescription = null) },
            label = { Text("Platba") },
        )
        NavigationBarItem(
            selected = current == Routes.PENDING,
            onClick = { onSelect(Routes.PENDING) },
            icon = {
                BadgedBox(
                    badge = { if (pendingCount > 0) Badge { Text(pendingCount.toString()) } },
                ) {
                    Icon(Icons.Filled.ReportProblem, contentDescription = null)
                }
            },
            label = { Text("Neodeslané") },
        )
        NavigationBarItem(
            selected = current == Routes.SETTINGS,
            onClick = { onSelect(Routes.SETTINGS) },
            icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
            label = { Text("Nastavení") },
        )
    }
}
