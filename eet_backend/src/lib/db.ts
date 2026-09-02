export type EetStatus = "PENDING" | "SENT" | "REJECTED" | "EXPIRED";

export type EetSaleRow = {
  id: number;
  reference: string;
  amountCzk: string;
  status: EetStatus;
  eic: string;
  idJednotky: string;
  idPokl: string;
  datTrzby: string;
  pok: string | null;
  test: number | null;
  attempts: number;
  lastErrorCode: number | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function findByReference(db: D1Database, reference: string): Promise<EetSaleRow | null> {
  const row = await db.prepare("SELECT * FROM EetSale WHERE reference = ?").bind(reference).first<EetSaleRow>();
  return row ?? null;
}

export async function insertPending(
  db: D1Database,
  params: { reference: string; amountCzk: string; eic: string; idJednotky: string; idPokl: string; datTrzby: string },
): Promise<EetSaleRow> {
  const row = await db
    .prepare(
      `INSERT INTO EetSale (reference, amountCzk, status, eic, idJednotky, idPokl, datTrzby, attempts)
       VALUES (?, ?, 'PENDING', ?, ?, ?, ?, 0) RETURNING *`,
    )
    .bind(params.reference, params.amountCzk, params.eic, params.idJednotky, params.idPokl, params.datTrzby)
    .first<EetSaleRow>();
  if (!row) throw new Error("insert into EetSale returned no row");
  return row;
}

export async function markSent(db: D1Database, id: number, pok: string, test: boolean): Promise<void> {
  await db
    .prepare(`UPDATE EetSale SET status = 'SENT', pok = ?, test = ?, attempts = attempts + 1, updatedAt = datetime('now') WHERE id = ?`)
    .bind(pok, test ? 1 : 0, id)
    .run();
}

/**
 * Records a failed attempt. Status always stays (or becomes) `PENDING` —
 * every failure, whether transient or an EET protocol-level rejection, is
 * retried until either it succeeds or the 48h ZoET deadline hits (see
 * `markExpired`). The caller (stena-letnak) has no way to act on an
 * immediate hard failure anyway, so there's no early-exit "give up now"
 * path anymore; `REJECTED` is kept in `EetStatus` only to read back rows
 * written before this change.
 */
export async function markAttemptFailed(db: D1Database, id: number, errorCode: number | null, errorMessage: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE EetSale SET status = 'PENDING', attempts = attempts + 1, lastErrorCode = ?, lastErrorMessage = ?, updatedAt = datetime('now') WHERE id = ?`,
    )
    .bind(errorCode, errorMessage, id)
    .run();
}

export async function listPending(db: D1Database, limit: number): Promise<EetSaleRow[]> {
  const result = await db.prepare(`SELECT * FROM EetSale WHERE status = 'PENDING' ORDER BY id ASC LIMIT ?`).bind(limit).all<EetSaleRow>();
  return result.results;
}

export type EetListFilter = {
  /** "ALL" skips the status condition entirely. */
  status: EetStatus | "ALL";
  /** Inclusive, "YYYY-MM-DD", compared against `date(createdAt)`. */
  dateFrom: string;
  /** Inclusive, "YYYY-MM-DD", compared against `date(createdAt)`. */
  dateTo: string;
  limit: number;
};

/** Filtered rows, most recent first — backs the admin EET page in the stena-letnak app. */
export async function listFiltered(db: D1Database, filter: EetListFilter): Promise<EetSaleRow[]> {
  const conditions = ["date(createdAt) BETWEEN ? AND ?"];
  const params: unknown[] = [filter.dateFrom, filter.dateTo];
  if (filter.status !== "ALL") {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  params.push(filter.limit);
  const result = await db
    .prepare(`SELECT * FROM EetSale WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .bind(...params)
    .all<EetSaleRow>();
  return result.results;
}

/**
 * Gives up on automatic retry: the ZoET-mandated 48h window (offline-mode
 * reporting deadline, counted from the sale itself) has passed without a
 * successful registration. Row drops out of `listPending` (cron stops
 * touching it) but stays queryable via /status for manual follow-up —
 * same treatment as REJECTED, just a different root cause.
 */
export async function markExpired(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `UPDATE EetSale SET status = 'EXPIRED', lastErrorMessage = 'Missed the 48h legal reporting deadline (ZoET offline-mode limit) without a successful registration; needs manual follow-up.', updatedAt = datetime('now') WHERE id = ?`,
    )
    .bind(id)
    .run();
}

export type FioState = {
  id: 1;
  lastRunAt: string | null;
  lastReportedCount: number;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
};

/** The single `FioState` row, seeded by migration `0002_fio_state.sql`. */
export async function getFioState(db: D1Database): Promise<FioState> {
  const row = await db.prepare("SELECT * FROM FioState WHERE id = 1").first<FioState>();
  if (!row) throw new Error("FioState row missing — did migration 0002_fio_state.sql run?");
  return row;
}

export async function updateFioState(
  db: D1Database,
  patch: { lastRunAt: string; lastReportedCount: number; lastError: string | null; lastErrorAt: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE FioState SET lastRunAt = ?, lastReportedCount = ?, lastError = ?, lastErrorAt = ?, updatedAt = datetime('now') WHERE id = 1`,
    )
    .bind(patch.lastRunAt, patch.lastReportedCount, patch.lastError, patch.lastErrorAt)
    .run();
}
