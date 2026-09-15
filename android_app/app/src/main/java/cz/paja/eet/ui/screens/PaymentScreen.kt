package cz.paja.eet.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Spa
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import cz.paja.eet.data.PaymentPreset
import cz.paja.eet.ui.CashSubmissionState
import cz.paja.eet.ui.PaymentCategory
import cz.paja.eet.ui.PaymentMethod
import cz.paja.eet.ui.PaymentViewModel
import cz.paja.eet.ui.PajaBottomBar
import cz.paja.eet.ui.UnsentNotice
import cz.paja.eet.ui.PaymentOrderCard
import cz.paja.eet.ui.Routes
import cz.paja.eet.ui.theme.SectionLabel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaymentScreen(
    viewModel: PaymentViewModel,
    pendingCount: Int,
    onNavigate: (String) -> Unit,
    onShowTransferQr: () -> Unit,
) {
    val settings by viewModel.settings.collectAsState()
    val amount = viewModel.amountCzkOrNull()
    val readyForMethod = when (viewModel.method) {
        PaymentMethod.CASH -> settings.isEetConfigured
        PaymentMethod.TRANSFER -> settings.isBankConfigured
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Icons.Filled.Spa, contentDescription = null)
                        Text("Masáže")
                    }
                },
            )
        },
        bottomBar = { PajaBottomBar(Routes.PAYMENT, pendingCount, onNavigate) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (!settings.isEetConfigured || !settings.isBankConfigured) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Aplikace není plně nastavena.", fontWeight = FontWeight.Bold)
                        Text("Doplňte prosím EET a platební údaje v Nastavení, než začnete evidovat platby.")
                        TextButton(onClick = { onNavigate(Routes.SETTINGS) }) { Text("Přejít do Nastavení") }
                    }
                }
            }

            // The amount is what this screen is for; everything else is a choice
            // about it. It gets the size to match, so it can be read back to the
            // customer without leaning over the phone.
            OutlinedTextField(
                value = viewModel.amountText,
                onValueChange = viewModel::onAmountTextChanged,
                label = { Text("Částka (Kč)") },
                textStyle = MaterialTheme.typography.headlineMedium,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            if (settings.presets.isNotEmpty()) {
                PresetsRow(presets = settings.presets, onSelect = viewModel::selectPreset)
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("TYP PLATBY", style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                    SegmentedButton(
                        selected = viewModel.category == PaymentCategory.SERVICES,
                        onClick = { viewModel.onCategorySelected(PaymentCategory.SERVICES) },
                        shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    ) { Text("Masáž") }
                    SegmentedButton(
                        selected = viewModel.category == PaymentCategory.VOUCHERS,
                        onClick = { viewModel.onCategorySelected(PaymentCategory.VOUCHERS) },
                        shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    ) { Text("Poukázky") }
                }
            }

            if (viewModel.category == PaymentCategory.VOUCHERS) {
                OutlinedTextField(
                    value = viewModel.voucherNumber,
                    onValueChange = viewModel::onVoucherNumberChanged,
                    label = { Text("Číslo poukázky") },
                    supportingText = {
                        if (viewModel.voucherNumberRequired() && viewModel.voucherNumber.isBlank()) {
                            Text("Bez čísla poukázky nelze poukaz vystavit.")
                        }
                    },
                    isError = viewModel.voucherNumberRequired() && viewModel.voucherNumber.isBlank(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
            }

            // Offered for every sale, not just vouchers: the customer gets a
            // receipt either way. Left blank, nothing is sent and no order is
            // recorded — the operator has decided to hand the paperwork over.
            val emailInvalid = viewModel.customerEmailInvalid()
            OutlinedTextField(
                value = viewModel.customerEmail,
                onValueChange = viewModel::onCustomerEmailChanged,
                label = { Text("E-mail zákazníka (nepovinné)") },
                supportingText = {
                    val isVoucher = viewModel.category == PaymentCategory.VOUCHERS
                    Text(
                        when {
                            emailInvalid -> "Zkontrolujte prosím adresu."
                            else -> {
                                val what = if (isVoucher) "Poukaz i účet" else "Účet"
                                if (viewModel.method == PaymentMethod.CASH) "$what se pošle hned po zaevidování."
                                else "$what se pošle, jakmile platba dorazí."
                            }
                        },
                    )
                },
                isError = emailInvalid,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("ZPŮSOB PLATBY", style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                    SegmentedButton(
                        selected = viewModel.method == PaymentMethod.CASH,
                        onClick = { viewModel.onMethodSelected(PaymentMethod.CASH) },
                        shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    ) { Text("Hotovost") }
                    SegmentedButton(
                        selected = viewModel.method == PaymentMethod.TRANSFER,
                        onClick = { viewModel.onMethodSelected(PaymentMethod.TRANSFER) },
                        shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    ) { Text("Převodem") }
                }
            }

            val cashState = viewModel.cashState
            val voucherDetailsMissing = viewModel.voucherNumberRequired() && viewModel.voucherNumber.isBlank()
            val canSubmit = amount != null && readyForMethod && !voucherDetailsMissing &&
                !viewModel.customerEmailInvalid() && cashState !is CashSubmissionState.Loading

            Button(
                onClick = {
                    when (viewModel.method) {
                        PaymentMethod.CASH -> viewModel.submitCashPayment()
                        // Records the voucher order alongside the QR; never blocks on it.
                        PaymentMethod.TRANSFER -> if (viewModel.submitTransfer()) onShowTransferQr()
                    }
                },
                enabled = canSubmit,
                contentPadding = PaddingValues(vertical = 16.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (viewModel.method == PaymentMethod.CASH) "Zaevidovat platbu" else "Vytvořit QR kód",
                    style = MaterialTheme.typography.titleMedium,
                )
            }

            if (viewModel.method == PaymentMethod.CASH) {
                CashResultCard(cashState, onNewPayment = viewModel::startNewPayment)
                // Separate from the EET result on purpose: the sale can be
                // registered while the voucher e-mail still needs a retry, and
                // saying so beats implying the whole payment failed.
                PaymentOrderCard(viewModel.orderState)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PresetsRow(presets: List<PaymentPreset>, onSelect: (PaymentPreset) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(presets, key = { it.id }) { preset ->
            AssistChip(
                onClick = { onSelect(preset) },
                label = { Text("${preset.description} (${preset.amountCzk} Kč)") },
            )
        }
    }
}

@Composable
private fun CashResultCard(state: CashSubmissionState, onNewPayment: () -> Unit) {
    when (state) {
        is CashSubmissionState.Idle -> Unit
        is CashSubmissionState.Loading -> Card {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(32.dp))
                Text("Evidují se tržba…", modifier = Modifier.padding(top = 8.dp))
            }
        }
        is CashSubmissionState.Success -> Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Platba zaevidována", fontWeight = FontWeight.Bold)
                Text("FIK/POK: ${state.pok}")
                Button(onClick = onNewPayment) { Text("Nová platba") }
            }
        }
        is CashSubmissionState.Queued -> Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Platba přijata, čeká na zpracování", fontWeight = FontWeight.Bold)
                Text("Evidence proběhne na pozadí, jakmile bude spojení s finanční správou dostupné.")
                Button(onClick = onNewPayment) { Text("Nová platba") }
            }
        }
        // Deliberately not `state.message`: see UnsentNotice.
        is CashSubmissionState.Error -> UnsentNotice("Platba nebyla odeslána, odešle se později.")
    }
}
