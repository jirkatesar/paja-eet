-- Single-row table tracking the Fio bank-poll's own "IfDue" state — when it
-- last ran, how many transactions it registered, and the last error (if
-- any). Fio's own "last" endpoint tracks the new-transactions bookmark
-- server-side per token, so this table only needs to remember *when* we last
-- called it, not *what* we last saw.
CREATE TABLE FioState (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lastRunAt TEXT,
  lastReportedCount INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  lastErrorAt TEXT,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO FioState (id) VALUES (1);
