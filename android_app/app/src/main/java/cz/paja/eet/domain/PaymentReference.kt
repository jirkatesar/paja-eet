package cz.paja.eet.domain

import java.util.Calendar

/**
 * The variable symbol for payments that have no number of their own.
 *
 * A voucher number is written by staff and printed on the voucher, so it is the
 * variable symbol of that payment. A massage has no such number — but its
 * payment still has to be told apart from every other one, because the Worker
 * matches the incoming transfer by variable symbol to know whose receipt to
 * send. So one is generated here.
 *
 * The format is `MMddHHmmss`: ten digits, which is the longest a Czech variable
 * symbol may be, and it carries the time it was issued, which is what makes it
 * unique — two payments cannot be started in the same second at one till. It
 * repeats yearly, which is harmless: an order only holds its symbol for the
 * 30 days before it expires, and the Worker rejects a symbol that is still in
 * use rather than quietly sharing it.
 */
object PaymentReference {

    /** Ten digits, e.g. 0915221433 for 15 September at 22:14:33. */
    fun from(calendar: Calendar): String = buildString {
        append2(calendar.get(Calendar.MONTH) + 1)
        append2(calendar.get(Calendar.DAY_OF_MONTH))
        append2(calendar.get(Calendar.HOUR_OF_DAY))
        append2(calendar.get(Calendar.MINUTE))
        append2(calendar.get(Calendar.SECOND))
    }

    /** The same, for now. */
    fun now(): String = from(Calendar.getInstance())

    private fun StringBuilder.append2(value: Int) {
        if (value < 10) append('0')
        append(value)
    }
}
