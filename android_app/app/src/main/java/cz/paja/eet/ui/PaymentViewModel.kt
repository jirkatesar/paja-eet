package cz.paja.eet.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.EetReportResult
import cz.paja.eet.data.VoucherOrderResult
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

    /**
     * Where to e-mail the voucher, for a voucher paid by transfer. Optional: left
     * blank, the QR is still generated but no order is recorded, so nothing will
     * be sent automatically and the voucher has to be handed over by hand.
     */
    var customerEmail by mutableStateOf("")
        private set

    var cashState: CashSubmissionState by mutableStateOf(CashSubmissionState.Idle)
        private set

    var transferQr: TransferQrData? by mutableStateOf(null)
        private set

    /** Progress of the voucher-order call that runs alongside the QR code. */
    var voucherOrderState: VoucherOrderState by mutableStateOf(VoucherOrderState.Idle)
        private set

    /** Stable per-transaction id, reused across retries so the EET Worker can dedupe. */
    private var cashReference: String? = null

    /**
     * What to send the Worker if the order has to be retried. Kept here rather
     * than read back off the screen, so a retry works the same whether the
     * voucher was paid by transfer (retried from the QR) or in cash (retried
     * from the payment screen).
     */
    private var lastOrderRequest: OrderRequest? = null

    private data class OrderRequest(
        val amountCzk: Int,
        val voucherNumber: String,
        val email: String,
        val constantSymbol: String?,
        val cash: Boolean,
    )

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
        customerEmail = ""
        resetTransactionState()
    }

    fun onVoucherNumberChanged(value: String) {
        if (value.length > 10) return
        if (value.isNotEmpty() && value.toIntOrNull() == null) return
        voucherNumber = value
        resetTransactionState()
    }

    fun onCustomerEmailChanged(value: String) {
        if (value.length > 200) return
        customerEmail = value
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
        voucherOrderState = VoucherOrderState.Idle
        lastOrderRequest = null
    }

    fun startNewPayment() {
        amountText = ""
        note = ""
        voucherNumber = ""
        customerEmail = ""
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

        // A voucher sold for cash is already paid, so its order goes out `cash =
        // true` and the Worker e-mails the voucher straight away — no bank
        // transfer to wait for. It runs alongside the EET report rather than
        // after it: one failing must not take the other down with it.
        voucherEmailOrNull()?.let { email ->
            recordVoucherOrder(
                OrderRequest(amountCzk = amount, voucherNumber = voucherNumber, email = email, constantSymbol = null, cash = true),
            )
        }

        viewModelScope.launch {
            cashState = CashSubmissionState.Loading
            cashState = when (val result = eetApiClient.reportSale(current.eetUrl, current.eetToken, reference, amount)) {
                is EetReportResult.Success -> CashSubmissionState.Success(result.pok)
                is EetReportResult.Queued -> CashSubmissionState.Queued
                is EetReportResult.Error -> CashSubmissionState.Error(result.message)
            }
        }
    }

    /** True when a non-blank e-mail was entered but doesn't look like an address — a typo worth catching before the payment. */
    fun customerEmailInvalid(): Boolean {
        val email = customerEmail.trim()
        return email.isNotEmpty() && !EMAIL_RE.matches(email)
    }

    /**
     * Whether the voucher number is needed to proceed. It always is for a
     * transfer (it becomes the payment's variable symbol), and for cash as soon
     * as an e-mail is given — an order is keyed by the voucher number, so without
     * one there is nothing to record and nothing to send.
     */
    fun voucherNumberRequired(): Boolean =
        category == PaymentCategory.VOUCHERS && (method == PaymentMethod.TRANSFER || customerEmail.isNotBlank())

    /**
     * Builds the SPD transfer QR payload and, for a voucher with an e-mail,
     * records the order at the Worker so the incoming transfer can be matched and
     * the voucher sent to the customer.
     *
     * Returns as soon as the *QR* is ready; the order call runs on in the
     * background and can only ever add a warning next to the QR. The customer is
     * standing at the counter — a Worker that is unreachable must not stop them
     * from paying, so this deliberately never blocks on the network.
     */
    fun submitTransfer(): Boolean {
        if (!buildTransferQr()) return false
        val qr = transferQr ?: return false
        // No e-mail means no order to record: staff opted to hand the voucher over themselves.
        val email = qr.customerEmail?.takeIf { it.isNotBlank() } ?: return true
        val voucherNumber = qr.voucherNumber ?: return true
        recordVoucherOrder(
            OrderRequest(
                amountCzk = qr.amountCzk,
                voucherNumber = voucherNumber,
                email = email,
                constantSymbol = qr.constantSymbol,
                cash = false,
            ),
        )
        return true
    }

    /**
     * Re-runs the last order call, from whichever screen asked for it. Safe to
     * repeat: the Worker holds the voucher number, so a second call answers
     * `409`, which counts as recorded rather than as a failure.
     */
    fun retryVoucherOrder() {
        lastOrderRequest?.let { recordVoucherOrder(it) }
    }

    /** The customer's e-mail, or null when there is none to send a voucher to. */
    private fun voucherEmailOrNull(): String? = customerEmail.trim().takeIf { it.isNotBlank() }

    private fun recordVoucherOrder(request: OrderRequest) {
        lastOrderRequest = request
        val current = settings.value
        if (!current.isEetConfigured) {
            voucherOrderState = VoucherOrderState.Failed("EET_URL a EET_TOKEN nejsou v Nastavení vyplněné, objednávku nelze zaevidovat.")
            return
        }
        viewModelScope.launch {
            voucherOrderState = VoucherOrderState.Recording
            val result = eetApiClient.createVoucherOrder(
                eetUrl = current.eetUrl,
                eetToken = current.eetToken,
                amountCzk = request.amountCzk,
                variableSymbol = request.voucherNumber,
                email = request.email,
                constantSymbol = request.constantSymbol,
                cash = request.cash,
            )
            voucherOrderState = when (result) {
                VoucherOrderResult.Recorded, VoucherOrderResult.AlreadyExists -> VoucherOrderState.Recorded
                is VoucherOrderResult.Error -> VoucherOrderState.Failed(result.message)
            }
        }
    }

    /**
     * Builds the SPD transfer QR payload; returns false if bank settings, amount, or (for
     * vouchers) the voucher number or a malformed e-mail are missing/invalid.
     */
    private fun buildTransferQr(): Boolean {
        val amount = amountCzkOrNull() ?: return false
        val current = settings.value
        if (!current.isBankConfigured) return false
        val isVoucher = category == PaymentCategory.VOUCHERS
        if (isVoucher && voucherNumber.isBlank()) return false
        if (isVoucher && customerEmailInvalid()) return false

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
            transferQr = TransferQrData(
                spdPayload = spd,
                amountCzk = amount,
                category = category,
                constantSymbol = ks,
                voucherNumber = if (isVoucher) voucherNumber else null,
                customerEmail = if (isVoucher) customerEmail.trim() else null,
            )
            true
        } catch (e: Exception) {
            false
        }
    }

    private companion object {
        /**
         * Deliberately loose — just enough to catch a typo before the customer
         * pays. The Worker validates properly; this only saves a round trip that
         * would otherwise surface as a warning beside an already-generated QR.
         */
        val EMAIL_RE = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")
    }
}
