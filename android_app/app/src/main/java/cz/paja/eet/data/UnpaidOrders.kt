package cz.paja.eet.data

import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

/**
 * An order the Worker recorded but has not been paid for yet — the other half of
 * the story the till cannot see on its own.
 *
 * The app knows a QR was handed over; only the Worker knows whether the money
 * ever arrived, because it is the one matching the bank transfers. Without this
 * the operator has no way of telling a payment that is still on its way from one
 * that was never sent at all, and an unpaid order quietly expires after
 * `ttlDays`, taking its variable symbol back.
 */
data class UnpaidOrder(
    val id: Long,
    val variableSymbol: String,
    val amountCzk: Int,
    val kind: PaymentKind,
    val email: String,
    /** When the order was made, as an epoch millisecond — null when the Worker's stamp could not be read. */
    val createdAt: Long?,
    /**
     * Why a payment that *did* arrive failed to settle this order — an amount or
     * constant-symbol mismatch, written by the Fio poll. Worth showing loudly:
     * this is the case where the customer believes they have paid.
     */
    val matchProblem: String?,
)

/** The orders still waiting to be paid, plus how long the Worker keeps one before it expires. */
data class UnpaidOrders(
    val orders: List<UnpaidOrder>,
    /** `VOUCHER_ORDER_TTL_DAYS` as the Worker has it set; null when it did not say. */
    val ttlDays: Int?,
)

/**
 * When the order stops being usable — the Worker expires an unpaid one after
 * `ttlDays` and frees its variable symbol (see `expireOrders` there). Null when
 * either half is unknown, which is the case where nothing can honestly be said
 * about a deadline.
 */
fun UnpaidOrder.expiresAt(ttlDays: Int?): Long? =
    createdAt?.let { created -> ttlDays?.let { days -> created + days * MILLIS_PER_DAY } }

private const val MILLIS_PER_DAY = 24L * 60 * 60 * 1000

/**
 * Reads the amount back into the whole koruny the app works in.
 *
 * The Worker stores it as a decimal string (`"1500.00"` — SQLite has no other
 * number to store CZK in), so the app cannot simply take it as an Int.
 */
fun parseAmountCzk(raw: String): Int? = raw.trim().toDoubleOrNull()?.roundToInt()

/** D1's `datetime('now')`, the format the Worker's own columns use. */
private val WORKER_TIMESTAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

/**
 * Reads a timestamp as the Worker writes it — `"2026-09-15 12:34:56"`: UTC, with
 * no timezone marker on it.
 *
 * Read as UTC deliberately. Taking it as local time would shift every date by
 * the Prague offset, which is enough to show the wrong day for anything ordered
 * in the evening — and the date is most of what this screen has to say about an
 * order. An ISO-8601 stamp with an explicit offset is accepted too, so a Worker
 * that starts sending one does not silently blank the dates.
 */
fun parseWorkerTimestamp(raw: String): Long? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    return runCatching { LocalDateTime.parse(text, WORKER_TIMESTAMP).toInstant(ZoneOffset.UTC).toEpochMilli() }
        .recoverCatching { OffsetDateTime.parse(text).toInstant().toEpochMilli() }
        .getOrNull()
}
