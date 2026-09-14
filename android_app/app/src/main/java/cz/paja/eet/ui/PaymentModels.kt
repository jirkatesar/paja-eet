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
sealed class VoucherOrderState {
    data object Idle : VoucherOrderState()
    data object Recording : VoucherOrderState()
    data object Recorded : VoucherOrderState()
    data class Failed(val message: String) : VoucherOrderState()
}

data class TransferQrData(
    val spdPayload: String,
    val amountCzk: Int,
    val category: PaymentCategory,
    val constantSymbol: String,
    val voucherNumber: String? = null,
    /** Customer address the voucher should go to; blank when staff chose not to record an order. */
    val customerEmail: String? = null,
)
