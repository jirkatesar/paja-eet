package cz.paja.eet.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.EetReportResult
import cz.paja.eet.data.AppSettings
import cz.paja.eet.data.PaymentPreset
import cz.paja.eet.data.SettingsRepository
import cz.paja.eet.domain.CzechBankQr
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID

class PaymentViewModel(
    private val settingsRepository: SettingsRepository,
    private val eetApiClient: EetApiClient,
) : ViewModel() {

    val settings: StateFlow<AppSettings> = settingsRepository.settingsFlow.stateIn(
        viewModelScope, SharingStarted.WhileSubscribed(5_000), AppSettings(),
    )

    var amountText by mutableStateOf("")
        private set
    var category by mutableStateOf(PaymentCategory.SERVICES)
        private set
    var method by mutableStateOf(PaymentMethod.CASH)
        private set

    /** Description of the selected preset, if any — becomes the SPD message (visible to both parties). */
    var note by mutableStateOf("")
        private set

    /** Only relevant for [PaymentCategory.VOUCHERS] — becomes the SPD variable symbol (X-VS). */
    var voucherNumber by mutableStateOf("")
        private set

    var cashState: CashSubmissionState by mutableStateOf(CashSubmissionState.Idle)
        private set

    var transferQr: TransferQrData? by mutableStateOf(null)
        private set

    /** Stable per-transaction id, reused across retries so the EET Worker can dedupe. */
    private var cashReference: String? = null

    fun onAmountTextChanged(value: String) {
        if (value.length > 9) return
        if (value.isNotEmpty() && value.toIntOrNull() == null) return
        amountText = value
        note = ""
        resetTransactionState()
    }

    fun onCategorySelected(value: PaymentCategory) {
        category = value
        voucherNumber = ""
        resetTransactionState()
    }

    fun onVoucherNumberChanged(value: String) {
        if (value.length > 10) return
        if (value.isNotEmpty() && value.toIntOrNull() == null) return
        voucherNumber = value
        resetTransactionState()
    }

    fun onMethodSelected(value: PaymentMethod) {
        method = value
        resetTransactionState()
    }

    fun selectPreset(preset: PaymentPreset) {
        amountText = preset.amountCzk.toString()
        note = preset.description
        resetTransactionState()
    }

    private fun resetTransactionState() {
        cashState = CashSubmissionState.Idle
        cashReference = null
        transferQr = null
    }

    fun startNewPayment() {
        amountText = ""
        note = ""
        voucherNumber = ""
        resetTransactionState()
    }

    fun amountCzkOrNull(): Int? = amountText.trim().toIntOrNull()?.takeIf { it > 0 }

    fun submitCashPayment() {
        val amount = amountCzkOrNull() ?: return
        val current = settings.value
        if (!current.isEetConfigured) {
            cashState = CashSubmissionState.Error("Nejprve nastavte EET_URL a EET_TOKEN v Nastavení.")
            return
        }
        val reference = cashReference ?: UUID.randomUUID().toString().also { cashReference = it }

        viewModelScope.launch {
            cashState = CashSubmissionState.Loading
            cashState = when (val result = eetApiClient.reportSale(current.eetUrl, current.eetToken, reference, amount)) {
                is EetReportResult.Success -> CashSubmissionState.Success(result.pok)
                is EetReportResult.Queued -> CashSubmissionState.Queued
                is EetReportResult.Error -> CashSubmissionState.Error(result.message)
            }
        }
    }

    /**
     * Builds the SPD transfer QR payload; returns false if bank settings, amount, or (for
     * vouchers) the voucher number are missing/invalid.
     */
    fun buildTransferQr(): Boolean {
        val amount = amountCzkOrNull() ?: return false
        val current = settings.value
        if (!current.isBankConfigured) return false
        val isVoucher = category == PaymentCategory.VOUCHERS
        if (isVoucher && voucherNumber.isBlank()) return false

        val ks = if (isVoucher) current.ksVouchers else current.ksServices
        val message = if (isVoucher) listOf("POUKAZKA", note).filter { it.isNotBlank() }.joinToString(" ") else note
        return try {
            val spd = CzechBankQr.buildSpdPayload(
                CzechBankQr.SpdParams(
                    accountNumber = current.bankAccountNumber,
                    bankCode = current.bankCode,
                    amountCzk = amount,
                    variableSymbol = if (isVoucher) voucherNumber else null,
                    constantSymbol = ks,
                    message = message.ifBlank { null },
                ),
            )
            transferQr = TransferQrData(spd, amount, category, ks, voucherNumber = if (isVoucher) voucherNumber else null)
            true
        } catch (e: Exception) {
            false
        }
    }
}
