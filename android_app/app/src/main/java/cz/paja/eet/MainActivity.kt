package cz.paja.eet

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import cz.paja.eet.ui.AppViewModelFactory
import cz.paja.eet.ui.PaymentViewModel
import cz.paja.eet.ui.SettingsViewModel
import cz.paja.eet.ui.screens.PaymentScreen
import cz.paja.eet.ui.screens.SettingsScreen
import cz.paja.eet.ui.screens.TransferQrScreen
import cz.paja.eet.ui.theme.PajaEetTheme

private const val ROUTE_PAYMENT = "payment"
private const val ROUTE_SETTINGS = "settings"
private const val ROUTE_TRANSFER_QR = "transfer_qr"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val app = application as PajaEetApplication
        val factory = AppViewModelFactory(app.settingsRepository, app.eetApiClient, app.pendingRepository)

        setContent {
            PajaEetTheme {
                val navController = rememberNavController()
                val paymentViewModel: PaymentViewModel = viewModel(factory = factory)

                NavHost(navController = navController, startDestination = ROUTE_PAYMENT) {
                    composable(ROUTE_PAYMENT) {
                        PaymentScreen(
                            viewModel = paymentViewModel,
                            onOpenSettings = { navController.navigate(ROUTE_SETTINGS) },
                            onShowTransferQr = { navController.navigate(ROUTE_TRANSFER_QR) },
                        )
                    }
                    composable(ROUTE_SETTINGS) {
                        val settingsViewModel: SettingsViewModel = viewModel(factory = factory)
                        SettingsScreen(viewModel = settingsViewModel, onBack = { navController.popBackStack() })
                    }
                    composable(ROUTE_TRANSFER_QR) {
                        // Captured once on entry: the "Zavřít" button clears transferQr on the
                        // ViewModel as part of leaving this screen, and re-reading it reactively
                        // here would flip this route to blank mid-navigation.
                        val qrData = remember { paymentViewModel.transferQr }
                        if (qrData == null) {
                            LaunchedEffect(Unit) { navController.popBackStack() }
                        } else {
                            // The order state is read reactively on purpose: recording it
                            // runs in the background and its outcome (a warning, or the
                            // confirmation that the voucher will be sent) only exists after
                            // this screen is already on display.
                            TransferQrScreen(
                                data = qrData,
                                orderState = paymentViewModel.orderState,
                                onRetryOrder = { paymentViewModel.retryOrder() },
                                onBack = { navController.popBackStack() },
                                onNewPayment = { paymentViewModel.startNewPayment() },
                            )
                        }
                    }
                }
            }
        }
    }
}
