package cz.paja.eet.ui

enum class PaymentCategory { SERVICES, VOUCHERS }

enum class PaymentMethod { CASH, TRANSFER }

sealed class CashSubmissionState {
    data object Idle : CashSubmissionState()
    data object Loading : CashSubmissionState()
    data class Success(val pok: String) : CashSubmissionState()
    data object Queued : CashSubmissionState()
    data class Error(val message: String) : CashSubmissionState()
}

/**
 * Recording a voucher order at the Worker, so the incoming transfer can be
 * matched and the voucher e-mailed. Deliberately does *not* gate the QR code:
 * the customer is standing at the counter and can pay regardless, so a failure
 * here is surfaced as a warning next to the QR rather than a blocked payment.
 */
sealed class PaymentOrderState {
    data object Idle : PaymentOrderState()
    data object Recording : PaymentOrderState()
    data object Recorded : PaymentOrderState()
    data class Failed(val message: String) : PaymentOrderState()
}

data class TransferQrData(
    val spdPayload: String,
    val amountCzk: Int,
    val category: PaymentCategory,
    val constantSymbol: String,
    /** The voucher number for a voucher, a generated one for a service — both are what the payment carries. */
    val variableSymbol: String,
    /** Customer address the receipt (and voucher) should go to; blank means nothing is sent. */
    val customerEmail: String,
)
