package cz.paja.eet.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.paja.eet.data.EetApiClient
import cz.paja.eet.data.EetReportResult
import cz.paja.eet.data.AppSettings
import cz.paja.eet.data.PaymentKind
import cz.paja.eet.data.PendingOperation
import cz.paja.eet.data.PendingOperationsRepository
import cz.paja.eet.data.PaymentOrderResult
import cz.paja.eet.data.PaymentPreset
import cz.paja.eet.data.SettingsRepository
import cz.paja.eet.domain.CzechBankQr
import cz.paja.eet.domain.PaymentReference
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

class PaymentViewModel(
    private val settingsRepository: SettingsRepository,
    private val eetApiClient: EetApiClient,
    private val pendingRepository: PendingOperationsRepository,
) : ViewModel() {

    /** Sales the Worker has not been told about yet, oldest first. */
    val pending: StateFlow<List<PendingOperation>> = pendingRepository.queueFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    var retrying by mutableStateOf(false)
        private set

    /** One line about the last retry round, shown next to the button. */
    var retryResult by mutableStateOf<String?>(null)
        private set

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
    var orderState: PaymentOrderState by mutableStateOf(PaymentOrderState.Idle)
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
        val variableSymbol: String,
        val email: String,
        val kind: PaymentKind,
        val constantSymbol: String?,
        val cash: Boolean,
        /** The EET reference for a cash sale, so a failed registration can be queued with it. */
        val reportReference: String?,
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
        orderState = PaymentOrderState.Idle
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
        // Generated once and reused: it identifies this sale in the queue, and a
        // retry that invented a new one would file a second, unrelated sale.
        val variableSymbol = variableSymbolFor()

        // Anything sold for cash is already paid, so its order goes out `cash =
        // true` and the Worker sends the receipt straight away — a voucher as
        // well, a service just the receipt. It runs alongside the EET report
        // rather than after it: one failing must not take the other down with it.
        //
        // With no e-mail there is nobody to send to, so no order is made at all.
        voucherEmailOrNull()?.let { email ->
            recordOrder(
                OrderRequest(
                    amountCzk = amount,
                    variableSymbol = variableSymbol,
                    email = email,
                    kind = kindFor(),
                    constantSymbol = null,
                    cash = true,
                    reportReference = reference,
                ),
            )
        }

        viewModelScope.launch {
            cashState = CashSubmissionState.Loading
            cashState = when (val result = eetApiClient.reportSale(current.eetUrl, current.eetToken, reference, amount)) {
                is EetReportResult.Success -> CashSubmissionState.Success(result.pok)
                is EetReportResult.Queued -> CashSubmissionState.Queued
                is EetReportResult.Error -> {
                    // The sale is taken but not registered. Queue it so it is not
                    // lost when the phone cannot reach the Worker.
                    rememberFailedSale(
                        PendingOperation(
                            cash = true,
                            amountCzk = amount,
                            variableSymbol = variableSymbol,
                            email = "",
                            kind = kindFor(),
                            constantSymbol = null,
                            reportReference = reference,
                        ),
                    )
                    CashSubmissionState.Error(result.message)
                }
            }
        }
    }

    /** What is being sold: a voucher gets its PDF, a service only the receipt. */
    private fun kindFor(): PaymentKind =
        if (category == PaymentCategory.VOUCHERS) PaymentKind.VOUCHER else PaymentKind.SERVICE

    /**
     * The variable symbol this payment will carry. A voucher has one already —
     * the number staff wrote on it. A service has none, so one is generated;
     * the Worker matches the incoming transfer on it, which is how the right
     * customer gets the receipt.
     */
    private fun variableSymbolFor(): String =
        if (category == PaymentCategory.VOUCHERS) voucherNumber else PaymentReference.now()

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
        // No e-mail, no order: there would be nobody to send the receipt to, so
        // nothing is recorded and staff hand the voucher over themselves.
        val email = qr.customerEmail.takeIf { it.isNotBlank() } ?: return true
        recordOrder(
            OrderRequest(
                amountCzk = qr.amountCzk,
                variableSymbol = qr.variableSymbol,
                email = email,
                kind = kindFor(),
                constantSymbol = qr.constantSymbol,
                cash = false,
                reportReference = null,
            ),
        )
        return true
    }

    /**
     * Re-runs the last order call, from whichever screen asked for it. Safe to
     * repeat: the Worker holds the voucher number, so a second call answers
     * `409`, which counts as recorded rather than as a failure.
     */
    fun retryOrder() {
        lastOrderRequest?.let { recordOrder(it) }
    }

    /** The customer's e-mail, or null when there is nobody to send to — in which case nothing is ordered. */
    private fun voucherEmailOrNull(): String? = customerEmail.trim().takeIf { it.isNotBlank() }

    private fun recordOrder(request: OrderRequest) {
        lastOrderRequest = request
        val current = settings.value
        if (!current.isEetConfigured) {
            orderState = PaymentOrderState.Failed("EET_URL a EET_TOKEN nejsou v Nastavení vyplněné, objednávku nelze zaevidovat.")
            rememberFailedOrder(request, "EET_URL a EET_TOKEN nejsou v Nastavení vyplněné.")
            return
        }
        viewModelScope.launch {
            orderState = PaymentOrderState.Recording
            val result = eetApiClient.createOrder(
                eetUrl = current.eetUrl,
                eetToken = current.eetToken,
                amountCzk = request.amountCzk,
                variableSymbol = request.variableSymbol,
                email = request.email,
                kind = request.kind,
                constantSymbol = request.constantSymbol,
                cash = request.cash,
            )
            orderState = when (result) {
                PaymentOrderResult.Recorded, PaymentOrderResult.AlreadyExists -> PaymentOrderState.Recorded
                is PaymentOrderResult.Error -> {
                    rememberFailedOrder(request, result.message)
                    PaymentOrderState.Failed(result.message)
                }
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
        // Every payment carries a variable symbol now, not just a voucher: it is
        // how the Worker tells whose transfer arrived and who gets the receipt.
        val variableSymbol = variableSymbolFor()
        return try {
            val spd = CzechBankQr.buildSpdPayload(
                CzechBankQr.SpdParams(
                    accountNumber = current.bankAccountNumber,
                    bankCode = current.bankCode,
                    amountCzk = amount,
                    variableSymbol = variableSymbol,
                    constantSymbol = ks,
                    message = message.ifBlank { null },
                ),
            )
            transferQr = TransferQrData(
                spdPayload = spd,
                amountCzk = amount,
                category = category,
                constantSymbol = ks,
                variableSymbol = variableSymbol,
                customerEmail = customerEmail.trim(),
            )
            true
        } catch (e: Exception) {
            false
        }
    }

    // ------------------------------------------------------------- the queue

    /** Remembers a sale the Worker could not be told about, so it can be told later. */
    private fun rememberFailedSale(operation: PendingOperation) {
        viewModelScope.launch { pendingRepository.addOrUpdate(operation) }
    }

    private fun rememberFailedOrder(request: OrderRequest, message: String) {
        rememberFailedSale(
            PendingOperation(
                cash = request.cash,
                amountCzk = request.amountCzk,
                variableSymbol = request.variableSymbol,
                email = request.email,
                kind = request.kind,
                constantSymbol = request.constantSymbol,
                reportReference = request.reportReference,
                lastError = message,
            ),
        )
    }

    init {
        // While the app is running, keep trying. Foreground-only on purpose: the
        // till is either open with somebody looking at it, or it is not, and a
        // background job would want a permission and a scheduler to do useful
        // work only while a customer is standing there.
        viewModelScope.launch {
            while (true) {
                val configured = settings.value.retryIntervalMinutes
                val minutes = if (configured > 0) configured else AppSettings.DEFAULT_RETRY_INTERVAL_MINUTES
                delay(minutes * 60_000L)
                if (pending.value.isNotEmpty()) retryPending()
            }
        }
    }

    /** Sends every queued sale again; whatever still fails stays in the queue. */
    fun retryPending() {
        if (retrying) return
        viewModelScope.launch {
            retrying = true
            val queued = pending.value
            val sentIds = mutableSetOf<String>()
            val stillFailing = mutableListOf<PendingOperation>()
            for (item in queued) {
                val error = send(item)
                if (error == null) {
                    sentIds += item.id
                } else {
                    stillFailing += item.copy(attempts = item.attempts + 1, lastError = error)
                }
            }
            // Removes only what actually went through, against whatever is in the
            // queue right now — not against the list read before the network calls.
            pendingRepository.applyRetryResult(sentIds, stillFailing)
            retrying = false
            retryResult =
                when {
                    queued.isEmpty() -> null
                    stillFailing.isEmpty() -> "Odesláno: ${sentIds.size}"
                    else -> "Odesláno: ${sentIds.size}, zbývá: ${stillFailing.size}"
                }
        }
    }

    /**
     * Returns null once everything this sale needed has been sent.
     *
     * Both calls are safe to repeat — the Worker dedupes the EET report on its
     * reference and answers 409 for a variable symbol it already holds — so the
     * app does not have to remember which half of a sale got through, and a
     * retry can simply re-send the whole thing.
     */
    private suspend fun send(item: PendingOperation): String? {
        val current = settings.value
        if (!current.isEetConfigured) return "EET_URL a EET_TOKEN nejsou v Nastavení vyplněné."

        item.reportReference?.let { reference ->
            when (val result = eetApiClient.reportSale(current.eetUrl, current.eetToken, reference, item.amountCzk)) {
                is EetReportResult.Success, EetReportResult.Queued -> Unit
                is EetReportResult.Error -> return result.message
            }
        }

        if (item.email.isNotBlank()) {
            val result = eetApiClient.createOrder(
                eetUrl = current.eetUrl,
                eetToken = current.eetToken,
                amountCzk = item.amountCzk,
                variableSymbol = item.variableSymbol,
                email = item.email,
                kind = item.kind,
                constantSymbol = item.constantSymbol,
                cash = item.cash,
            )
            when (result) {
                PaymentOrderResult.Recorded, PaymentOrderResult.AlreadyExists -> Unit
                is PaymentOrderResult.Error -> return result.message
            }
        }

        return null
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
