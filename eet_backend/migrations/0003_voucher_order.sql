-- Objednávka dárkového poukazu. Vzniká zavoláním POST /voucher/order z appky.
--
-- U převodu (paymentMethod = 'TRANSFER') objednávka čeká v PENDING, dokud ji
-- Fio poll nespáruje s příchozí platbou podle VS + částky + KS; pak se poukaz
-- vygeneruje a odešle e-mailem. U hotovosti ('CASH') se rovnou zakládá jako
-- PAID a odesílá se hned — na nic se nečeká.
CREATE TABLE VoucherOrder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variableSymbol TEXT NOT NULL,   -- jak přišel; tiskne se jako číslo poukazu
  vsNormalized TEXT NOT NULL,     -- bez vedoucích nul; pro párování a unikátnost
  amountCzk TEXT NOT NULL,        -- "1500.00"
  constantSymbol TEXT NOT NULL DEFAULT '',  -- normalizovaný; u hotovosti prázdný
  email TEXT NOT NULL,
  paymentMethod TEXT NOT NULL DEFAULT 'TRANSFER',  -- TRANSFER | CASH
  status TEXT NOT NULL DEFAULT 'PENDING',          -- PENDING | PAID | SENT | EXPIRED | CANCELLED
  fioIdPohyb TEXT,                -- spárovaná transakce (idempotence + audit)
  paidAt TEXT,
  sentAt TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Číslo poukazu nesmí existovat dvakrát — ani když už byl poukaz doručený,
-- protože se pořád může někdo pokusit uplatnit starý vytištěný kus. Uvolní se
-- až expirací (objednávka zaplacená nikdy nebyla) nebo zrušením.
CREATE UNIQUE INDEX idx_voucherorder_vs_active
  ON VoucherOrder(vsNormalized) WHERE status IN ('PENDING', 'PAID', 'SENT');

CREATE INDEX idx_voucherorder_status ON VoucherOrder(status);
