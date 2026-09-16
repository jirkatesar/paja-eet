package cz.paja.eet.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.HourglassEmpty
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
import cz.paja.eet.ui.theme.BarLabel

/** The places this app can be. Kept as strings so they match the nav routes. */
object Routes {
    const val PAYMENT = "payment"
    const val UNPAID = "unpaid"
    const val PENDING = "pending"
    const val SETTINGS = "settings"
    const val TRANSFER_QR = "transfer_qr"
}

/**
 * The app's menu.
 *
 * Four destinations is still what a bar at the bottom is for: it is what a thumb
 * reaches without letting go of the phone, and the till is used standing up.
 *
 * Two of the entries are lists of things that have gone wrong, and they are
 * different kinds of wrong: "Nezaplacené" is an order the Worker is holding
 * while nobody has paid for it — the money never arrived. "Neodeslané" is a sale
 * this phone could not tell the Worker about at all. The icons and the screens
 * behind them carry the distinction; the labels alone would not.
 *
 * The count on "Neodeslané" is the point of the whole screen behind it — a sale
 * that never reached EET is a legal record with a deadline, and a plain menu
 * entry would not say whether anything is waiting there. The unpaid list has no
 * badge for the opposite reason: knowing its size takes a call to the Worker,
 * and a number that is only right when somebody last looked is worse than none.
 */
@Composable
fun PajaBottomBar(current: String, pendingCount: Int, onSelect: (String) -> Unit) {
    NavigationBar {
        NavigationBarItem(
            selected = current == Routes.PAYMENT,
            onClick = { onSelect(Routes.PAYMENT) },
            icon = { Icon(Icons.Filled.Payments, contentDescription = null) },
            label = { Text("Platba", style = BarLabel) },
        )
        NavigationBarItem(
            selected = current == Routes.UNPAID,
            onClick = { onSelect(Routes.UNPAID) },
            icon = { Icon(Icons.Filled.HourglassEmpty, contentDescription = null) },
            label = { Text("Nezaplacené", style = BarLabel) },
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
            label = { Text("Neodeslané", style = BarLabel) },
        )
        NavigationBarItem(
            selected = current == Routes.SETTINGS,
            onClick = { onSelect(Routes.SETTINGS) },
            icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
            label = { Text("Nastavení", style = BarLabel) },
        )
    }
}
