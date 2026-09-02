package cz.paja.eet.domain

/**
 * Czech "Short Payment Descriptor" (SPD) bank-transfer QR payload.
 * Spec: https://qr-platba.cz/pro-vyvojare/specifikace-formatu/
 */
object CzechBankQr {

    class InvalidAccountException : Exception("INVALID_ACCOUNT")
    class InvalidAmountException : Exception("INVALID_AMOUNT")

    data class ParsedAccount(val prefix: String, val number: String, val bankCode: String)

    /** ISO 7064 MOD 97-10 checksum, used by the IBAN check digits. */
    private fun mod97(numeric: String): Int {
        var checksum = 0
        for (ch in numeric) {
            checksum = (checksum * 10 + (ch - '0')) % 97
        }
        return checksum
    }

    /** Parses a domestic "prefix-number/bank" string, or separate number + bank code fields. */
    fun parseCzechAccount(accountNumber: String, bankCode: String = ""): ParsedAccount? {
        var raw = accountNumber.trim().replace(Regex("\\s+"), "")
        var bank = bankCode.trim().replace(Regex("\\s+"), "")

        if (raw.contains("/")) {
            val parts = raw.split("/", limit = 2)
            raw = parts.getOrElse(0) { "" }
            bank = parts.getOrElse(1) { "" }.ifEmpty { bank }
        }
        if (raw.isEmpty() || bank.isEmpty()) return null

        var prefix = ""
        var number = raw
        if (raw.contains("-")) {
            val parts = raw.split("-", limit = 2)
            prefix = parts.getOrElse(0) { "" }
            number = parts.getOrElse(1) { "" }
        }

        if (prefix.isNotEmpty() && !Regex("^\\d{1,6}$").matches(prefix)) return null
        if (!Regex("^\\d{1,10}$").matches(number)) return null
        if (!Regex("^\\d{4}$").matches(bank)) return null

        return ParsedAccount(prefix.ifEmpty { "0" }, number, bank)
    }

    /** Converts a CZ domestic account + bank code to IBAN, or normalizes an existing IBAN. */
    fun toCzechIban(accountNumber: String, bankCode: String = ""): String? {
        val cleaned = accountNumber.trim().replace(Regex("\\s+"), "").uppercase()
        if (Regex("^CZ\\d{22}$").matches(cleaned)) return cleaned

        val parsed = parseCzechAccount(accountNumber, bankCode) ?: return null

        val prefix = parsed.prefix.padStart(6, '0')
        val number = parsed.number.padStart(10, '0')
        val bank = parsed.bankCode.padStart(4, '0')
        val bban = "$bank$prefix$number"
        // "CZ00" -> letters as digits (C=12, Z=35) -> "123500", per ISO 13616.
        val check = 98 - mod97("${bban}123500")
        return "CZ${check.toString().padStart(2, '0')}$bban"
    }

    data class SpdParams(
        val accountNumber: String,
        val bankCode: String,
        val amountCzk: Int,
        val variableSymbol: String? = null,
        val constantSymbol: String? = null,
        val message: String? = null,
    )

    fun buildSpdPayload(params: SpdParams): String {
        val iban = toCzechIban(params.accountNumber, params.bankCode) ?: throw InvalidAccountException()
        if (params.amountCzk < 0) throw InvalidAmountException()

        val amount = String.format(java.util.Locale.ROOT, "%.2f", params.amountCzk.toDouble())
        val parts = mutableListOf("SPD*1.0", "ACC:$iban", "AM:$amount", "CC:CZK")

        params.variableSymbol?.let {
            val vs = it.replace(Regex("\\D"), "").take(10)
            if (vs.isNotEmpty()) parts.add("X-VS:$vs")
        }

        params.constantSymbol?.let {
            val ks = it.replace(Regex("\\D"), "").take(4)
            if (ks.isNotEmpty()) parts.add("X-KS:$ks")
        }

        params.message?.let { raw ->
            val msg = java.text.Normalizer.normalize(raw, java.text.Normalizer.Form.NFD)
                .replace(Regex("\\p{Mn}+"), "")
                .replace("*", " ")
                .replace(Regex("\\s+"), " ")
                .trim()
                .take(60)
            if (msg.isNotEmpty()) parts.add("MSG:$msg")
        }

        return parts.joinToString("*")
    }
}
