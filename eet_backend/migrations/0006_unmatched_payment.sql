-- Příchozí platby, ke kterým v okamžiku stažení neexistovala objednávka.
--
-- Dosud poll hlásil každý kredit v korunách do EET a párování s objednávkou
-- bylo jen otázka doručení. Od teď se evidují pouze platby spárované
-- s objednávkou — a tím vzniká problém, který tahle tabulka řeší:
--
-- Fio posouvá záložku při každém úspěšném stažení, takže platba, kterou poll
-- viděl, se už nikdy nevrátí. Když objednávka vznikne až po stažení (zákazník
-- zaplatí dřív, než personál dokončí objednávku), není se o platbě jak
-- dozvědět. Proto se sem uloží a objednávka si ji při vzniku vyzvedne.
--
-- Řádky se mažou po `AppConfig.unmatchedPaymentTtlDays` dnech; držet je věčně
-- by znamenalo tabulku, která jen roste.
CREATE TABLE UnmatchedPayment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Fio's own transaction id. UNIQUE, takže přehraný poll (nebo dvě volání za
  -- sebou) neuloží tutéž platbu dvakrát.
  fioIdPohyb TEXT NOT NULL UNIQUE,
  amountCzk TEXT NOT NULL,
  vsNormalized TEXT NOT NULL,
  constantSymbol TEXT NOT NULL DEFAULT '',
  datTrzby TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_unmatched_vs ON UnmatchedPayment(vsNormalized);

-- Jak dlouho držet nespárované platby. NULL = použij ENV, pak výchozích 30 dní.
ALTER TABLE AppConfig ADD COLUMN unmatchedPaymentTtlDays INTEGER;
