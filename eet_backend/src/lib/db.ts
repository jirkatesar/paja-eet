export type EetStatus = "PENDING" | "SENT" | "REJECTED" | "EXPIRED";

/**
 * Parses either timestamp format this schema stores, in ms since epoch.
 *
 * Two formats coexist on purpose: D1's `datetime('now')` yields
 * "YYYY-MM-DD HH:MM:SS" (space-separated, UTC, no zone suffix) and is what
 * `createdAt`/`updatedAt` use, while anything this Worker generates in JS
 * (`nowIso()`, `Date.toISOString()`) is full ISO 8601 ending in "Z". Feeding
 * the ISO form to a D1-format-only parser appends a second "Z" and yields
 * `NaN` — which silently disables any comparison it feeds rather than
 * throwing, so both forms are accepted here.
 */
export function sqliteDatetimeMs(s: string): number {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}

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
 * `expireOverdue`). The caller (stena-letnak) has no way to act on an
 * immediate hard failure anyway, so there's no early-exit "give up now"
 * path anymore; `REJECTED` is kept in `EetStatus` only to read back rows
 * written before this change.
 *
 * The `status = 'PENDING'` guard matters: a cron retry and a `POST /report`
 * retry can be in flight for the same row at the same time, and without it a
 * loser of that race would clobber a `markSent` written moments earlier back
 * to `PENDING`, re-submitting an already-registered sale. Guards against
 * `SENT`/`EXPIRED` (a terminal state always wins).
 */
export async function markAttemptFailed(db: D1Database, id: number, errorCode: number | null, errorMessage: string | null): Promise<void> {
  await db
    .prepare(
      `UPDATE EetSale SET status = 'PENDING', attempts = attempts + 1, lastErrorCode = ?, lastErrorMessage = ?, updatedAt = datetime('now') WHERE id = ? AND status = 'PENDING'`,
    )
    .bind(errorCode, errorMessage, id)
    .run();
}

/**
 * The next batch of rows for the cron to retry, least-attempted first.
 *
 * Ordering by `attempts` rather than `id` is what stops one poisoned row (or
 * a whole batch of them, e.g. during a multi-hour EET outage) from
 * monopolizing every run: with N pending rows and a batch of B, ordering by
 * id would retry the same B oldest rows every minute and never touch the
 * other N-B until the first ones expire, while ordering by attempts
 * round-robins through the whole set. Ties break on id so rows are still
 * drained oldest-first within an equal-attempt cohort.
 *
 * Rows past the 48h deadline are taken out of `PENDING` by `expireOverdue`
 * before this runs, so they can't be starved out of ever expiring by having
 * the highest attempt count.
 */
export async function listPending(db: D1Database, limit: number): Promise<EetSaleRow[]> {
  const result = await db
    .prepare(`SELECT * FROM EetSale WHERE status = 'PENDING' ORDER BY attempts ASC, id ASC LIMIT ?`)
    .bind(limit)
    .all<EetSaleRow>();
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

const EXPIRED_MESSAGE =
  "Missed the 48h legal reporting deadline (ZoET offline-mode limit) without a successful registration; needs manual follow-up.";

/**
 * Gives up on automatic retry for every row past the ZoET-mandated
 * `olderThanHours` window (offline-mode reporting deadline, counted from the
 * sale itself). Expired rows drop out of `listPending` (the cron stops
 * touching them) but stay queryable via /status and on the admin dashboard
 * for manual follow-up — same treatment as REJECTED, just a different root
 * cause. Returns the references it expired, for the caller to log.
 *
 * Deliberately a set-based sweep rather than part of the cron's per-row
 * retry loop: the retry loop only sees one batch, so a row that never made
 * it into a batch would never be marked (and so never stop being retried).
 *
 * The deadline is measured against `datTrzby` — the sale time — not
 * `createdAt`, which for the Fio poll is merely when the poll happened to
 * run; a transfer that arrived while the Worker was down must not get a
 * fresh 48h from the moment it was finally noticed. `datetime()` parses both
 * `datTrzby`'s ISO-with-Z form and D1's own, so no JS-side date math is
 * needed. The `status = 'PENDING'` guard keeps a sale that was registered
 * between the SELECT and the UPDATE from being flipped to EXPIRED.
 */
export async function expireOverdue(db: D1Database, olderThanHours: number): Promise<string[]> {
  const modifier = `-${olderThanHours} hours`;
  const condition = `status = 'PENDING' AND datetime(datTrzby) < datetime('now', ?)`;

  const overdue = await db.prepare(`SELECT reference FROM EetSale WHERE ${condition}`).bind(modifier).all<{ reference: string }>();
  if (overdue.results.length === 0) return [];

  await db
    .prepare(`UPDATE EetSale SET status = 'EXPIRED', lastErrorMessage = ?, updatedAt = datetime('now') WHERE ${condition}`)
    .bind(EXPIRED_MESSAGE, modifier)
    .run();

  return overdue.results.map((row) => row.reference);
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

export type PaymentOrderStatus = "PENDING" | "PAID" | "SENT" | "EXPIRED" | "CANCELLED";
export type PaymentMethod = "TRANSFER" | "CASH";

/** What a settled order sends: a voucher also gets its PDF, a service only the receipt. */
export type PaymentKind = "VOUCHER" | "SERVICE";

export type PaymentOrderRow = {
  id: number;
  variableSymbol: string;
  vsNormalized: string;
  amountCzk: string;
  constantSymbol: string;
  email: string;
  kind: PaymentKind;
  paymentMethod: PaymentMethod;
  status: PaymentOrderStatus;
  fioIdPohyb: string | null;
  paidAt: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertPaymentOrderParams = {
  variableSymbol: string;
  vsNormalized: string;
  amountCzk: string;
  constantSymbol: string;
  email: string;
  kind: PaymentKind;
  paymentMethod: PaymentMethod;
  /** Transfers start `PENDING` (waiting for the bank payment); cash starts `PAID` and is delivered immediately. */
  status: PaymentOrderStatus;
};

/** True when `error` is the partial unique index rejecting a second order for the same variable symbol. */
export function isDuplicateVariableSymbol(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE") && message.includes("vsNormalized");
}

export async function insertPaymentOrder(db: D1Database, params: InsertPaymentOrderParams): Promise<PaymentOrderRow> {
  const row = await db
    .prepare(
      `INSERT INTO PaymentOrder (variableSymbol, vsNormalized, amountCzk, constantSymbol, email, kind, paymentMethod, status, paidAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'PAID' THEN datetime('now') ELSE NULL END)
       RETURNING *`,
    )
    .bind(
      params.variableSymbol,
      params.vsNormalized,
      params.amountCzk,
      params.constantSymbol,
      params.email,
      params.kind,
      params.paymentMethod,
      params.status,
      params.status,
    )
    .first<PaymentOrderRow>();
  if (!row) throw new Error("insert into PaymentOrder returned no row");
  return row;
}

export async function getPaymentOrder(db: D1Database, id: number): Promise<PaymentOrderRow | null> {
  const row = await db.prepare("SELECT * FROM PaymentOrder WHERE id = ?").bind(id).first<PaymentOrderRow>();
  return row ?? null;
}

/**
 * The columns an edit may change — nothing else, whatever a caller passes. A
 * status, a payment method or a `paidAt` is not something an edit sets: those
 * are what the bank and the mailer decide.
 */
export type PaymentOrderPatch = {
  amountCzk?: string;
  variableSymbol?: string;
  vsNormalized?: string;
  constantSymbol?: string;
  email?: string;
  kind?: PaymentKind;
};

const PATCHABLE_COLUMNS: (keyof PaymentOrderPatch)[] = [
  "amountCzk",
  "variableSymbol",
  "vsNormalized",
  "constantSymbol",
  "email",
  "kind",
];

/**
 * Applies the fields given, leaving the rest of the order alone, and hands back
 * the row as it now stands — null when there is no order with that id.
 *
 * Validated by the caller (`lib/paymentOrder.ts`'s `editPaymentOrder`), which is
 * also where the rule lives about what may change once an order has been
 * settled. A variable symbol another live order already holds throws here (the
 * partial unique index), which the caller turns into a 409.
 */
export async function updatePaymentOrder(db: D1Database, id: number, patch: PaymentOrderPatch): Promise<PaymentOrderRow | null> {
  const columns = PATCHABLE_COLUMNS.filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return getPaymentOrder(db, id);

  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  const row = await db
    .prepare(`UPDATE PaymentOrder SET ${assignments}, updatedAt = datetime('now') WHERE id = ? RETURNING *`)
    .bind(...columns.map((column) => patch[column]), id)
    .first<PaymentOrderRow>();
  return row ?? null;
}

/** The `PENDING` order a bank transaction is expected to settle, matched on the normalized variable symbol. */
export async function findPendingPaymentOrder(db: D1Database, vsNormalized: string): Promise<PaymentOrderRow | null> {
  const row = await db
    .prepare(`SELECT * FROM PaymentOrder WHERE vsNormalized = ? AND status = 'PENDING'`)
    .bind(vsNormalized)
    .first<PaymentOrderRow>();
  return row ?? null;
}

/**
 * Records the matching bank transaction and moves the order to `PAID`. Guarded
 * on `PENDING` for the same reason `markAttemptFailed` is: a replayed poll must
 * not re-open or re-stamp an order that has already moved on.
 */
export async function markOrderPaid(db: D1Database, id: number, fioIdPohyb: string): Promise<void> {
  await db
    .prepare(
      `UPDATE PaymentOrder SET status = 'PAID', fioIdPohyb = ?, paidAt = datetime('now'), updatedAt = datetime('now')
       WHERE id = ? AND status = 'PENDING'`,
    )
    .bind(fioIdPohyb, id)
    .run();
}

/**
 * Finishes an order's delivery when there was nothing to deliver — an order
 * with no address (see `fulfilOrder`), which the app now records for cash sales
 * as well as transfers.
 *
 * Status `SENT` and `sentAt` left null on purpose: nothing was sent, and a
 * timestamp there would be a claim that something was. What matters is that the
 * order leaves the delivery retry queue, which `SENT` does.
 */
export async function markOrderNothingToSend(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `UPDATE PaymentOrder SET status = 'SENT', attempts = attempts + 1, lastError = NULL, updatedAt = datetime('now') WHERE id = ? AND status = 'PAID'`,
    )
    .bind(id)
    .run();
}

export async function markOrderSent(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `UPDATE PaymentOrder SET status = 'SENT', sentAt = datetime('now'), attempts = attempts + 1, lastError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    )
    .bind(id)
    .run();
}

/**
 * Records a failed *delivery* (the voucher PDF or the e-mail). Status stays
 * `PAID`: the money did arrive, so this is not the order's problem to lose —
 * the cron keeps retrying until it goes out.
 */
export async function markOrderSendFailed(db: D1Database, id: number, errorMessage: string): Promise<void> {
  await db
    .prepare(
      `UPDATE PaymentOrder SET attempts = attempts + 1, lastError = ?, updatedAt = datetime('now') WHERE id = ? AND status = 'PAID'`,
    )
    .bind(errorMessage.slice(0, 500), id)
    .run();
}

/** Paid orders whose voucher has not gone out yet — the cron's delivery retry queue. */
export async function listOrdersToSend(db: D1Database, limit: number): Promise<PaymentOrderRow[]> {
  const result = await db
    .prepare(`SELECT * FROM PaymentOrder WHERE status = 'PAID' AND sentAt IS NULL ORDER BY attempts ASC, id ASC LIMIT ?`)
    .bind(limit)
    .all<PaymentOrderRow>();
  return result.results;
}

/**
 * Gives up on orders that were never paid: releases the variable symbol (the
 * partial unique index stops covering `EXPIRED`) so it can be issued again.
 * Returns how many were expired, for the caller to log.
 */
export async function expireOrders(db: D1Database, olderThanDays: number): Promise<number> {
  // The message is built here rather than concatenated in SQL, where a bound
  // number renders as "30.0" and produces "do 30.0 dní".
  const message = `Unpaid ${olderThanDays} days after ordering; the voucher number is free for reuse.`;
  const result = await db
    .prepare(
      `UPDATE PaymentOrder SET status = 'EXPIRED', lastError = ?, updatedAt = datetime('now')
       WHERE status = 'PENDING' AND datetime(createdAt) < datetime('now', ?)`,
    )
    .bind(message, `-${olderThanDays} days`)
    .run();
  return result.meta.changes ?? 0;
}

export type PaymentOrderFilter = {
  status: PaymentOrderStatus | "ALL";
  limit: number;
  /**
   * Oldest first instead of the default newest first. The admin dashboard wants
   * the latest rows at the top; a list of orders still *waiting* for money wants
   * the opposite, because the ones worth chasing are the ones that have been
   * waiting longest and are closest to expiring.
   */
  oldestFirst?: boolean;
  /**
   * UTC instants (ISO-8601) bounding `createdAt`, half-open: `>= createdFrom`
   * and `< createdBefore`. One Prague calendar day, from `pragueDayRangeUtc` —
   * the conversion happens there rather than here because it needs the
   * timezone, and this function only knows about the database.
   */
  createdFrom?: string;
  createdBefore?: string;
};

/** Most recent first — backs the admin dashboard's orders table. */
export async function listPaymentOrders(db: D1Database, filter: PaymentOrderFilter): Promise<PaymentOrderRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== "ALL") {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  // `datetime(...)` on both sides normalizes the stored "YYYY-MM-DD HH:MM:SS"
  // (UTC) and the caller's ISO-8601 instant to the same comparable form.
  if (filter.createdFrom) {
    conditions.push("datetime(createdAt) >= datetime(?)");
    params.push(filter.createdFrom);
  }
  if (filter.createdBefore) {
    conditions.push("datetime(createdAt) < datetime(?)");
    params.push(filter.createdBefore);
  }
  params.push(filter.limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db
    .prepare(`SELECT * FROM PaymentOrder ${where} ORDER BY id ${filter.oldestFirst ? "ASC" : "DESC"} LIMIT ?`)
    .bind(...params)
    .all<PaymentOrderRow>();
  return result.results;
}

/**
 * The single `AppConfig` row, seeded by migration `0004_app_config.sql` — the
 * web configuration that overrides the environment. A NULL column means "not
 * overridden"; see `lib/appConfig.ts` for how that is resolved.
 *
 * `fioToken` and `smtpPassword` are stored in the clear here, unlike the
 * `wrangler secret` values they can override. Nothing in this Worker returns
 * them to a caller — the admin API reports only whether they are set — but
 * anyone with database access can read them.
 */
export type AppConfigRow = {
  id: 1;
  fioEnabled: number | null;
  fioPollIntervalSeconds: number | null;
  fioToken: string | null;
  unmatchedPaymentTtlDays: number | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: string | null;
  smtpFrom: string | null;
  smtpFromName: string | null;
  smtpUser: string | null;
  smtpPassword: string | null;
  updatedAt: string;
};

export async function getAppConfig(db: D1Database): Promise<AppConfigRow> {
  const row = await db.prepare("SELECT * FROM AppConfig WHERE id = 1").first<AppConfigRow>();
  if (!row) throw new Error("AppConfig row missing — did migration 0004_app_config.sql run?");
  return row;
}

/** Fields the config page may set. `undefined` leaves a column alone; `null` clears the override. */
export type AppConfigPatch = Partial<Omit<AppConfigRow, "id" | "updatedAt">>;

export async function updateAppConfig(db: D1Database, patch: AppConfigPatch): Promise<void> {
  const columns = Object.keys(patch) as (keyof AppConfigPatch)[];
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  await db
    .prepare(`UPDATE AppConfig SET ${assignments}, updatedAt = datetime('now') WHERE id = 1`)
    .bind(...columns.map((column) => patch[column] ?? null))
    .run();
}

/** Drops every override at once, putting the deployment back on its environment values. */
export async function resetAppConfig(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE AppConfig SET fioEnabled = NULL, fioPollIntervalSeconds = NULL, fioToken = NULL,
         smtpHost = NULL, smtpPort = NULL, smtpSecure = NULL, smtpFrom = NULL, smtpFromName = NULL,
         smtpUser = NULL, smtpPassword = NULL, unmatchedPaymentTtlDays = NULL, updatedAt = datetime('now')
       WHERE id = 1`,
    )
    .run();
}

/**
 * Records why an arriving payment did *not* settle a pending order — a symbol
 * that matched while the amount or the constant symbol did not.
 *
 * Deliberately not a status change: the order is still waiting, it just now
 * says what it is waiting for. Without this the reason lived only in a
 * `console.error`, which is no help at all to whoever is looking at the
 * dashboard wondering why a customer's payment never turned into a receipt.
 */
export async function noteMatchFailure(db: D1Database, id: number, message: string): Promise<void> {
  await db
    .prepare(`UPDATE PaymentOrder SET lastError = ?, updatedAt = datetime('now') WHERE id = ? AND status = 'PENDING'`)
    .bind(message.slice(0, 300), id)
    .run();
}

/**
 * An incoming bank payment that had no order to match when the poll fetched it.
 *
 * Kept because Fio's bookmark has already moved past it: the poll will never be
 * shown that transaction again, so without this the order created a minute later
 * could never learn that the money had already arrived.
 */
export type UnmatchedPaymentRow = {
  id: number;
  fioIdPohyb: string;
  amountCzk: string;
  vsNormalized: string;
  constantSymbol: string;
  datTrzby: string;
  createdAt: string;
};

/** Remembers a payment for a later order. A replayed poll must not store it twice. */
export async function insertUnmatchedPayment(
  db: D1Database,
  payment: { fioIdPohyb: string; amountCzk: string; vsNormalized: string; constantSymbol: string; datTrzby: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO UnmatchedPayment (fioIdPohyb, amountCzk, vsNormalized, constantSymbol, datTrzby)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(payment.fioIdPohyb, payment.amountCzk, payment.vsNormalized, payment.constantSymbol, payment.datTrzby)
    .run();
}

/** The payment a newly created order should be settled by, if it has already arrived. */
export async function findWaitingPayment(db: D1Database, vsNormalized: string): Promise<UnmatchedPaymentRow | null> {
  const row = await db
    .prepare(`SELECT * FROM UnmatchedPayment WHERE vsNormalized = ? ORDER BY id ASC LIMIT 1`)
    .bind(vsNormalized)
    .first<UnmatchedPaymentRow>();
  return row ?? null;
}

/** Called once an order has claimed the payment, so it cannot be claimed twice. */
export async function deleteUnmatchedPayment(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM UnmatchedPayment WHERE id = ?").bind(id).run();
}

/** Drops payments no order ever claimed. Returns how many went, for the cron to log. */
export async function pruneUnmatchedPayments(db: D1Database, olderThanDays: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM UnmatchedPayment WHERE datetime(createdAt) < datetime('now', ?)`)
    .bind(`-${olderThanDays} days`)
    .run();
  return result.meta.changes ?? 0;
}

/** Removes one registered sale. Returns false when there was nothing to remove. */
export async function deleteEetSale(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM EetSale WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Removes one order. Worth knowing before pressing it: the variable symbol only
 * stays taken while the order is live, so deleting an unfulfilled one frees its
 * number for a future sale — and the record of the sale is gone either way.
 */
export async function deletePaymentOrder(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM PaymentOrder WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
