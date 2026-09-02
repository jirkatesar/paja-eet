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

data class TransferQrData(
    val spdPayload: String,
    val amountCzk: Int,
    val category: PaymentCategory,
    val constantSymbol: String,
    val voucherNumber: String? = null,
)
