import * as db from "./db";
import { normalizeAmount, reportSale, type EetEnv } from "./reportSale";

export interface FioEnv extends EetEnv {
  /** Fio Banka API token. Fio poll is a no-op (never throws from the cron path) when unset. */
  FIO_TOKEN?: string;
  /** Minimum seconds between polls; parsed with a 30s floor and a 60s default — see `runFioPollIfDue`. */
  FIO_POLL_INTERVAL_SECONDS?: string;
}

type FioColumn = { value: unknown } | null | undefined;

type FioTransaction = {
  idPohyb: string;
  amountCzk: number;
  variableSymbol: string | null;
  constantSymbol: string | null;
  /** "Název protiúčtu" — the counterparty's name as registered with their bank. */
  senderName: string | null;
  /** "Zpráva pro příjemce" — the free-text note the payer attached to the transfer. */
  message: string | null;
  /** "Datum" — the bank's posting date, e.g. "2026-08-12+0200". Fio only supplies a calendar date, never a time-of-day. */
  date: string | null;
};

const MIN_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** D1's `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" (space-separated, UTC, no zone suffix). */
function sqliteDatetimeMs(s: string): number {
  return new Date(`${s.replace(" ", "T")}Z`).getTime();
}

/**
 * Fio's "last" endpoint returns only transactions since the previous
 * successful call — the bookmark is tracked server-side per token, so this
 * Worker doesn't need to persist a cursor of its own. An empty result leaves
 * the bookmark untouched, so polling on a fixed interval is always safe.
 * https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf §5.2.3
 */
async function fetchNewFioTransactions(token: string): Promise<FioTransaction[]> {
  const res = await fetch(`https://fioapi.fio.cz/v1/rest/last/${encodeURIComponent(token)}/transactions.json`);
  if (!res.ok) throw new Error(`FIO_HTTP_${res.status}`);

  const body = (await res.json()) as {
    accountStatement?: { transactionList?: { transaction?: Record<string, FioColumn>[] } | null };
  };
  const rows = body.accountStatement?.transactionList?.transaction ?? [];

  // Column indices per the official "Struktura TransactionList" table (§5.3.1.6):
  // column0 = Datum, column22 = ID pohybu, column1 = Objem, column5 = VS,
  // column4 = KS, column10 = Název protiúčtu, column16 = Zpráva pro příjemce.
  // Fio's JSON is inconsistent about whether numeric-looking fields come back
  // as JSON numbers or strings, so every value is coerced explicitly rather
  // than trusted to already be the right type.
  return rows.map((row) => ({
    idPohyb: String(row.column22?.value ?? ""),
    amountCzk: Number(row.column1?.value ?? NaN),
    variableSymbol: row.column5?.value != null ? String(row.column5.value).trim() : null,
    constantSymbol: row.column4?.value != null ? String(row.column4.value).trim() : null,
    senderName: row.column10?.value != null ? String(row.column10.value).trim() : null,
    message: row.column16?.value != null ? String(row.column16.value).trim() : null,
    date: row.column0?.value != null ? String(row.column0.value).trim() : null,
  }));
}

export type FioPollResult = { ranNow: boolean; reportedCount?: number };

/**
 * Polls Fio for new bank transfers and registers every incoming credit with
 * EET automatically. This Worker has no concept of "which order was this
 * for" — that's a consuming app's job (see stena-letnak's own Fio poll,
 * which matches against its `PaymentOrder` table before falling back to
 * reporting unmatched credits) — so here every positive-amount transaction
 * is treated as real revenue and reported as-is, keyed by Fio's own
 * `idPohyb` (`fio-<idPohyb>` reference). That reference is what makes this
 * idempotent: `reportSale` finds-or-creates by reference, so a transaction
 * already seen (e.g. a retried poll after a partial failure) is never
 * double-registered, and debit/outgoing transactions (negative amount) are
 * skipped entirely.
 *
 * Runs at most once every `FIO_POLL_INTERVAL_SECONDS` (or always, when
 * `force` is set — see `POST /fio/poll`); throttling state lives in the
 * single-row `FioState` D1 table (migration `0002_fio_state.sql`).
 */
export async function runFioPollIfDue(env: FioEnv, opts: { force?: boolean } = {}): Promise<FioPollResult> {
  if (!env.FIO_TOKEN) {
    if (opts.force) throw new Error("FIO_NOT_CONFIGURED");
    return { ranNow: false };
  }

  const state = await db.getFioState(env.DB);
  const pollIntervalSeconds = Math.max(MIN_POLL_INTERVAL_SECONDS, Number(env.FIO_POLL_INTERVAL_SECONDS) || DEFAULT_POLL_INTERVAL_SECONDS);
  const now = new Date();
  if (!opts.force && state.lastRunAt && now.getTime() - sqliteDatetimeMs(state.lastRunAt) < pollIntervalSeconds * 1000) {
    return { ranNow: false };
  }

  try {
    const transactions = await fetchNewFioTransactions(env.FIO_TOKEN);
    let reportedCount = 0;

    for (const txn of transactions) {
      if (!(txn.amountCzk > 0)) continue; // outgoing/debit transactions aren't revenue

      const amountCzk = normalizeAmount(txn.amountCzk);
      if (amountCzk === null) {
        console.error(`Fio poll: transaction ${txn.idPohyb} has an out-of-range amount (${txn.amountCzk}), skipping`);
        continue;
      }

      // Each transaction is handled independently — one unexpected failure here must not
      // abort the rest of the batch, since Fio's own "new since last call" bookmark has
      // already moved past every transaction in `transactions` by this point: anything not
      // finished processing now won't be returned by the next poll either.
      try {
        const result = await reportSale(env, `fio-${txn.idPohyb}`, amountCzk);
        if (result.status === "sent") reportedCount++;
      } catch (err) {
        console.error(`Fio poll: failed to report transaction ${txn.idPohyb}:`, err instanceof Error ? err.message : String(err));
      }
    }

    await db.updateFioState(env.DB, { lastRunAt: now.toISOString(), lastReportedCount: reportedCount, lastError: null, lastErrorAt: null });
    return { ranNow: true, reportedCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateFioState(env.DB, { lastRunAt: now.toISOString(), lastReportedCount: 0, lastError: message, lastErrorAt: now.toISOString() });
    throw err;
  }
}
