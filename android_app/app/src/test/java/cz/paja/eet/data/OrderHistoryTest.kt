package cz.paja.eet.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class OrderHistoryTest {

    @Test
    fun `amount is read back from the Worker's decimal string`() {
        assertEquals(1500, parseAmountCzk("1500.00"))
        assertEquals(1500, parseAmountCzk("1500"))
        assertEquals(7, parseAmountCzk(" 7.00 "))
    }

    @Test
    fun `sub-koruna precision is rounded, not truncated`() {
        // The Worker only ever stores whole koruny, so this is a rounding of
        // something that should not occur — it must not quietly lose a crown.
        assertEquals(100, parseAmountCzk("99.99"))
        assertEquals(1, parseAmountCzk("0.50"))
    }

    @Test
    fun `an amount that is not a number reads as unknown`() {
        assertNull(parseAmountCzk(""))
        assertNull(parseAmountCzk("neuvedeno"))
    }

    @Test
    fun `the Worker's timestamp is read as UTC`() {
        assertEquals(
            Instant.parse("2026-09-15T12:34:56Z").toEpochMilli(),
            parseWorkerTimestamp("2026-09-15 12:34:56"),
        )
    }

    @Test
    fun `an ISO stamp with an offset is accepted too`() {
        // Same moment as 12:34:56Z, written in Prague summer time.
        assertEquals(
            Instant.parse("2026-09-15T12:34:56Z").toEpochMilli(),
            parseWorkerTimestamp("2026-09-15T14:34:56+02:00"),
        )
    }

    @Test
    fun `a timestamp that cannot be read is unknown rather than now`() {
        assertNull(parseWorkerTimestamp(""))
        assertNull(parseWorkerTimestamp("—"))
    }

    @Test
    fun `only a settled order counts as paid`() {
        assertTrue(record("PAID").isPaid)
        assertTrue(record("SENT").isPaid)
        assertFalse(record("PENDING").isPaid)
        assertFalse(record("EXPIRED").isPaid)
        assertFalse(record("CANCELLED").isPaid)
        // An empty or invented status is the newer-Worker case: unpaid, because
        // that is the mistake that costs a glance rather than a customer.
        assertFalse(record("").isPaid)
        assertFalse(record("SOMETHING_NEW").isPaid)
    }

    private fun record(status: String) = OrderRecord(
        id = 1,
        variableSymbol = "2609220915",
        amountCzk = 500,
        kind = PaymentKind.SERVICE,
        email = "",
        status = status,
        createdAt = Instant.parse("2026-09-22T09:15:00Z").toEpochMilli(),
        paidAt = null,
        matchProblem = null,
    )
}
