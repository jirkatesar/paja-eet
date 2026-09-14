package cz.paja.eet.domain

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar
import java.util.GregorianCalendar

class PaymentReferenceTest {

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int): Calendar =
        GregorianCalendar(year, month - 1, day, hour, minute, second)

    @Test
    fun `reference is ten digits in MMddHHmmss order`() {
        assertEquals("0915221433", PaymentReference.from(at(2026, 9, 15, 22, 14, 33)))
    }

    @Test
    fun `single digit parts are padded`() {
        assertEquals("0102030405", PaymentReference.from(at(2026, 1, 2, 3, 4, 5)))
    }

    @Test
    fun `every part fits its two digits`() {
        val reference = PaymentReference.from(at(2026, 12, 31, 23, 59, 59))
        assertEquals("1231235959", reference)
        assertEquals(10, reference.length)
    }

    @Test
    fun `a second later is a different reference`() {
        val first = PaymentReference.from(at(2026, 9, 15, 22, 14, 33))
        val second = PaymentReference.from(at(2026, 9, 15, 22, 14, 34))
        assertEquals(false, first == second)
    }
}
