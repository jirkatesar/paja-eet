-- Objednávka platby, ne jen poukázky.
--
-- Dosud tahle tabulka držela pouze objednávky poukazek, protože jen ty měly
-- co párovat: platba za poukázku nese variabilní symbol, kdežto platba za
-- masáž ne. Appka teď posílá variabilní symbol i u masáže (generuje si ho),
-- takže se stejným postupem dá spárovat i platba za masáž — a na ni se má
-- poslat účet. Objednávka se tím stává obecnou a jméno ji přestalo sedět.
--
-- `kind` rozlišuje, co se po spárování pošle:
--   VOUCHER — poukaz (PDF) a k němu účet
--   SERVICE — jen účet
-- Stávající řádky jsou všechny poukázky, proto je výchozí hodnota VOUCHER.

ALTER TABLE VoucherOrder RENAME TO PaymentOrder;

ALTER TABLE PaymentOrder ADD COLUMN kind TEXT NOT NULL DEFAULT 'VOUCHER';

-- Index si přejmenování nese s sebou, ale jeho jméno by po rename lhalo.
DROP INDEX idx_voucherorder_vs_active;
CREATE UNIQUE INDEX idx_paymentorder_vs_active
  ON PaymentOrder(vsNormalized) WHERE status IN ('PENDING', 'PAID', 'SENT');

CREATE INDEX idx_paymentorder_kind ON PaymentOrder(kind);
