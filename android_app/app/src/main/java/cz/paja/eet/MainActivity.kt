package cz.paja.eet

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import cz.paja.eet.ui.AppViewModelFactory
import cz.paja.eet.ui.PaymentViewModel
import cz.paja.eet.ui.SettingsViewModel
import cz.paja.eet.ui.Routes
import cz.paja.eet.ui.screens.PaymentScreen
import cz.paja.eet.ui.screens.PendingScreen
import cz.paja.eet.ui.screens.SettingsScreen
import cz.paja.eet.ui.screens.TransferQrScreen
import cz.paja.eet.ui.theme.PajaEetTheme



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

                // The menu switches between the three destinations; the QR code
                // is a step in the middle of the payment flow, not one of them,
                // so it stays out of the bar and keeps its back arrow.
                val pendingCount by paymentViewModel.pending.collectAsState()

                fun goTo(route: String) {
                    // Arriving on the payment screen from anywhere else starts it
                    // clean. Tapping "Platba" while already there is not a switch,
                    // so it leaves the result the operator is reading alone.
                    if (route == Routes.PAYMENT && navController.currentBackStackEntry?.destination?.route != Routes.PAYMENT) {
                        paymentViewModel.clearResults()
                    }
                    navController.navigate(route) {
                        popUpTo(Routes.PAYMENT) { inclusive = route == Routes.PAYMENT }
                        launchSingleTop = true
                    }
                }

                NavHost(navController = navController, startDestination = Routes.PAYMENT) {
                    composable(Routes.PAYMENT) {
                        PaymentScreen(
                            viewModel = paymentViewModel,
                            pendingCount = pendingCount.size,
                            onNavigate = ::goTo,
                            onShowTransferQr = { navController.navigate(Routes.TRANSFER_QR) },
                        )
                    }
                    composable(Routes.PENDING) {
                        PendingScreen(
                            pending = pendingCount,
                            retrying = paymentViewModel.retrying,
                            retryResult = paymentViewModel.retryResult,
                            onRetry = paymentViewModel::retryPending,
                            onNavigate = ::goTo,
                        )
                    }
                    composable(Routes.SETTINGS) {
                        val settingsViewModel: SettingsViewModel = viewModel(factory = factory)
                        SettingsScreen(
                            viewModel = settingsViewModel,
                            pendingCount = pendingCount.size,
                            onNavigate = ::goTo,
                        )
                    }
                    composable(Routes.TRANSFER_QR) {
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
