package cz.paja.eet.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/**
 * Rows of `GET /orders`, read the way the phone reads them.
 *
 * **These do not reproduce the bug they exist because of.** On the phone,
 * `optString` on a JSON `null` returns the *string* `"null"` — which is what an
 * operator was shown in red under a warning triangle on the first real order
 * this screen ever displayed. The `org.json` these tests run against (a
 * test-only dependency, since android.jar's copy is a stub that throws) returns
 * `""` for the same input instead, so code that reads `optString` naively would
 * pass here and still break on the phone. Only an instrumented test could pin
 * that down, and there is no emulator in this setup.
 *
 * What they do cover is the mapping itself against a real library: which field
 * goes where, the `kind` fallback, a row with no usable amount being dropped,
 * and null/missing/empty all reading as "no reason". The load-bearing part is
 * `optTextOrNull`'s `isNull` check, which both libraries agree on — a KDoc on
 * it says as much, and that is deliberate.
 */
class UnpaidOrderJsonTest {

    @Test
    fun `a null lastError is no reason, not the word null`() {
        assertNull(unpaidOrderFrom(row(lastError = "null"))?.matchProblem)
    }

    @Test
    fun `a missing lastError is no reason either`() {
        assertNull(unpaidOrderFrom(row(includeLastError = false))?.matchProblem)
    }

    @Test
    fun `a match failure is carried through`() {
        val order = unpaidOrderFrom(row(lastError = "\"Platba dorazila, ale nesedí: expected 800 CZK\""))
        assertEquals("Platba dorazila, ale nesedí: expected 800 CZK", order?.matchProblem)
    }

    @Test
    fun `an empty lastError is no reason`() {
        assertNull(unpaidOrderFrom(row(lastError = "\"\""))?.matchProblem)
    }

    @Test
    fun `the whole row is read, timestamps as UTC`() {
        val order = unpaidOrderFrom(row())!!

        assertEquals(37L, order.id)
        assertEquals("2609151234", order.variableSymbol)
        assertEquals(1500, order.amountCzk)
        assertEquals(PaymentKind.VOUCHER, order.kind)
        assertEquals("jan@example.com", order.email)
        assertEquals(Instant.parse("2026-09-01T08:00:00Z").toEpochMilli(), order.createdAt)
    }

    @Test
    fun `a row without a usable amount is dropped rather than shown as zero`() {
        val withoutAmount = JSONObject("""{ "id": 1, "variableSymbol": "2609151234" }""")
        assertNull(unpaidOrderFrom(withoutAmount))
        assertNull(unpaidOrderFrom(row(amountCzk = "null")))
    }

    @Test
    fun `an unknown kind reads as a service`() {
        assertEquals(PaymentKind.SERVICE, unpaidOrderFrom(row(kind = "\"MYSTERY\""))?.kind)
        assertEquals(PaymentKind.SERVICE, unpaidOrderFrom(row(kind = "null"))?.kind)
    }

    private fun row(
        lastError: String = "null",
        amountCzk: String = "\"1500.00\"",
        kind: String = "\"VOUCHER\"",
        includeLastError: Boolean = true,
    ): JSONObject {
        val lastErrorField = if (includeLastError) """, "lastError": $lastError""" else ""
        return JSONObject(
            """
            { "id": 37, "variableSymbol": "2609151234", "amountCzk": $amountCzk, "constantSymbol": "308",
              "kind": $kind, "email": "jan@example.com", "status": "PENDING",
              "createdAt": "2026-09-01 08:00:00"$lastErrorField }
            """.trimIndent(),
        )
    }
}
