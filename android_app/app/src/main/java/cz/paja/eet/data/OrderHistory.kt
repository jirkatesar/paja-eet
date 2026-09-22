package cz.paja.eet.data

import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

/**
 * One payment of a day, as the Worker has it.
 *
 * The till hands over a QR code or takes the cash and then sees no further; the
 * Worker is the one that knows whether the money arrived. This is that half of
 * the story, per sale: what it was for, how much, and whether it has been paid.
 */
data class OrderRecord(
    val id: Long,
    val variableSymbol: String,
    val amountCzk: Int,
    val kind: PaymentKind,
    val email: String,
    /** The Worker's own word: `PENDING`, `PAID`, `SENT`, `EXPIRED` or `CANCELLED`. Kept as it came. */
    val status: String,
    /** When the sale was made — the day it belongs to. Null when the stamp could not be read. */
    val createdAt: Long?,
    /** When the money arrived, if it has. */
    val paidAt: Long?,
    /**
     * Why a payment that *did* arrive failed to settle this order — an amount or
     * constant-symbol mismatch, written by the Fio poll. The case where the
     * customer believes they have paid.
     */
    val matchProblem: String?,
) {
    /**
     * Whether the money is in.
     *
     * `SENT` counts as paid: an order only reaches it after being settled, when
     * its receipt goes out. Everything else — including a status a newer Worker
     * might invent — reads as not paid, which is the safer way to be wrong:
     * an unpaid row somebody looks at costs a glance, a paid one that never was
     * costs a customer.
     */
    val isPaid: Boolean get() = status == "PAID" || status == "SENT"
}

/** Everything the Worker has for one day. */
data class OrderHistory(val orders: List<OrderRecord>)

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
 * Read as UTC deliberately. Taking it as local time would shift every time by
 * the Prague offset, which is enough to show the wrong day for anything sold in
 * the evening — and the day is most of what the history screen has to say. An
 * ISO-8601 stamp with an explicit offset is accepted too, so a Worker that
 * starts sending one does not silently blank the dates.
 */
fun parseWorkerTimestamp(raw: String): Long? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    return runCatching { LocalDateTime.parse(text, WORKER_TIMESTAMP).toInstant(ZoneOffset.UTC).toEpochMilli() }
        .recoverCatching { OffsetDateTime.parse(text).toInstant().toEpochMilli() }
        .getOrNull()
}
