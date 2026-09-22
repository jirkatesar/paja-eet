package cz.paja.eet.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The Worker's answer to `GET /orders`, read the way the phone reads it.
 *
 * **These do not reproduce the JSON-null bug they exist because of.** On the
 * phone, `optString` on a JSON `null` returns the *string* `"null"` — which is
 * what an operator was shown in red under a warning triangle on the first real
 * order this screen ever displayed. The `org.json` these tests run against (a
 * test-only dependency, since android.jar's copy is a stub that throws) returns
 * `""` for the same input instead, so code that reads `optString` naively would
 * pass here and still break on the phone. Only an instrumented test could pin
 * that down, and there is no emulator in this setup.
 *
 * What they do cover is the reading itself against a real library: which field
 * goes where, what counts as paid, which errors are the till's business, and the
 * check that the Worker answered for the day that was asked for.
 */
class OrderHistoryJsonTest {

    @Test
    fun `a match failure is carried through`() {
        val order = orderRecordFrom(row(matchProblem = "\"Platba dorazila, ale nesedí: expected 800 CZK\""))
        assertEquals("Platba dorazila, ale nesedí: expected 800 CZK", order?.matchProblem)
    }

    @Test
    fun `a null matchProblem is no reason, not the word null`() {
        assertNull(orderRecordFrom(row(matchProblem = "null"))?.matchProblem)
    }

    @Test
    fun `a missing or empty matchProblem is no reason either`() {
        assertNull(orderRecordFrom(row(includeMatchProblem = false))?.matchProblem)
        assertNull(orderRecordFrom(row(matchProblem = "\"\""))?.matchProblem)
    }

    @Test
    fun `a delivery failure is not the till's business`() {
        // It sits in the same column as a match failure on the Worker, under a
        // different field. The row already says the money is in; a receipt the
        // mailer could not send is the operator's problem, shown in the dashboard.
        val deliveryFailure = JSONObject(
            """
            { "id": 1, "variableSymbol": "2609220915", "amountCzk": "500.00", "kind": "SERVICE",
              "status": "PAID", "createdAt": "2026-09-22 09:15:00", "paidAt": null,
              "lastError": "SMTP smtp.example.com:465: 535 incorrect credentials", "matchProblem": null }
            """.trimIndent(),
        )
        val order = orderRecordFrom(deliveryFailure)!!

        assertNull(order.matchProblem)
        assertTrue(order.isPaid)
    }

    @Test
    fun `a settled row says so, and says when the money came`() {
        val settled = JSONObject(
            """
            { "id": 1, "variableSymbol": "2609220915", "amountCzk": "500.00", "kind": "SERVICE",
              "status": "PAID", "createdAt": "2026-09-22 09:15:00", "paidAt": "2026-09-22 09:20:00", "matchProblem": null }
            """.trimIndent(),
        )
        val order = orderRecordFrom(settled)!!

        assertTrue(order.isPaid)
        assertEquals(Instant.parse("2026-09-22T09:20:00Z").toEpochMilli(), order.paidAt)
    }

    @Test
    fun `the whole row is read`() {
        val order = orderRecordFrom(row())!!

        assertEquals(37L, order.id)
        assertEquals("2609151234", order.variableSymbol)
        assertEquals(1500, order.amountCzk)
        assertEquals(PaymentKind.VOUCHER, order.kind)
        assertEquals("jan@example.com", order.email)
        assertEquals("PENDING", order.status)
        assertEquals(Instant.parse("2026-09-01T08:00:00Z").toEpochMilli(), order.createdAt)
    }

    @Test
    fun `a row without a usable amount is dropped rather than shown as zero`() {
        assertNull(orderRecordFrom(JSONObject("""{ "id": 1, "variableSymbol": "2609151234" }""")))
        assertNull(orderRecordFrom(row(amountCzk = "null")))
    }

    @Test
    fun `an unknown kind reads as a service`() {
        assertEquals(PaymentKind.SERVICE, orderRecordFrom(row(kind = "\"MYSTERY\""))?.kind)
        assertEquals(PaymentKind.SERVICE, orderRecordFrom(row(kind = "null"))?.kind)
    }

    @Test
    fun `a status nobody here knows is kept as it came, and counts as unpaid`() {
        // A newer Worker may invent one; guessing "paid" for it would be the
        // expensive way to be wrong.
        val order = orderRecordFrom(row(status = "\"SOMETHING_NEW\""))!!

        assertEquals("SOMETHING_NEW", order.status)
        assertFalse(order.isPaid)
    }

    @Test
    fun `an answer for the day asked for is a list`() {
        val result = historyFromResponse(response(day = "2026-09-22", rows = listOf(row())), day = "2026-09-22")

        assertTrue(result is OrderHistoryResult.Success)
        assertEquals(1, (result as OrderHistoryResult.Success).history.orders.size)
    }

    @Test
    fun `an answer that does not name the day is refused`() {
        // A Worker older than this app ignores `date` and answers with every
        // order it has. That looks exactly like a filter that does nothing, and
        // a day's takings read off the wrong day's list is worse than an error.
        val stale = JSONObject("""{ "rows": [], "ttlDays": 30 }""")

        assertEquals(OrderHistoryResult.Error(STALE_WORKER), historyFromResponse(stale, day = "2026-09-22"))
    }

    @Test
    fun `an answer for a different day is refused too`() {
        val otherDay = response(day = "2026-09-21", rows = listOf(row()))

        assertEquals(OrderHistoryResult.Error(STALE_WORKER), historyFromResponse(otherDay, day = "2026-09-22"))
    }

    private fun response(day: String, rows: List<JSONObject> = emptyList()): JSONObject {
        val array = JSONArray()
        rows.forEach { array.put(it) }
        return JSONObject().put("rows", array).put("date", day)
    }

    private fun row(
        amountCzk: String = "\"1500.00\"",
        kind: String = "\"VOUCHER\"",
        status: String = "\"PENDING\"",
        matchProblem: String = "null",
        includeMatchProblem: Boolean = true,
    ): JSONObject {
        val matchProblemField = if (includeMatchProblem) """, "matchProblem": $matchProblem""" else ""
        return JSONObject(
            """
            { "id": 37, "variableSymbol": "2609151234", "amountCzk": $amountCzk, "constantSymbol": "308",
              "kind": $kind, "email": "jan@example.com", "status": $status, "paidAt": null,
              "createdAt": "2026-09-01 08:00:00", "lastError": null$matchProblemField }
            """.trimIndent(),
        )
    }
}
