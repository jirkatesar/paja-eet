package cz.paja.eet.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CzechBankQrTest {

    @Test
    fun `known account converts to expected IBAN`() {
        // Widely-cited reference vector (e.g. Czech Wikipedia's IBAN article).
        assertEquals("CZ6508000000192000145399", CzechBankQr.toCzechIban("19-2000145399", "0800"))
    }

    @Test
    fun `slash notation is equivalent to separate fields`() {
        assertEquals(
            CzechBankQr.toCzechIban("19-2000145399", "0800"),
            CzechBankQr.toCzechIban("19-2000145399/0800"),
        )
    }

    @Test
    fun `account without prefix defaults prefix to zero`() {
        assertEquals("CZ7708000000000012345678", CzechBankQr.toCzechIban("12345678/0800"))
    }

    @Test
    fun `invalid bank code returns null`() {
        assertNull(CzechBankQr.toCzechIban("12345678/800"))
    }

    @Test
    fun `spd payload contains account amount and constant symbol`() {
        val spd = CzechBankQr.buildSpdPayload(
            CzechBankQr.SpdParams(
                accountNumber = "19-2000145399",
                bankCode = "0800",
                amountCzk = 250,
                constantSymbol = "0308",
            ),
        )
        assertEquals("SPD*1.0*ACC:CZ6508000000192000145399*AM:250.00*CC:CZK*X-KS:0308", spd)
    }

    @Test
    fun `spd payload includes variable symbol from voucher number ahead of constant symbol`() {
        val spd = CzechBankQr.buildSpdPayload(
            CzechBankQr.SpdParams(
                accountNumber = "19-2000145399",
                bankCode = "0800",
                amountCzk = 500,
                variableSymbol = "12345",
                constantSymbol = "0308",
            ),
        )
        assertEquals("SPD*1.0*ACC:CZ6508000000192000145399*AM:500.00*CC:CZK*X-VS:12345*X-KS:0308", spd)
    }
}
