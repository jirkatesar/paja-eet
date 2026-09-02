CREATE TABLE EetSale (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- also used as porad_cis (stringified)
  reference TEXT NOT NULL,
  amountCzk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SENT | EXPIRED (REJECTED is legacy-only, see CLAUDE.md)
  eic TEXT NOT NULL,
  idJednotky TEXT NOT NULL,
  idPokl TEXT NOT NULL,
  datTrzby TEXT NOT NULL, -- fixed at first attempt, reused on every retry (part of EET's own dedup key)
  pok TEXT,
  test INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  lastErrorCode INTEGER,
  lastErrorMessage TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_eetsale_reference ON EetSale(reference);
CREATE INDEX idx_eetsale_status ON EetSale(status);
