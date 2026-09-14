import * as db from "./db";
import { normalizeAmount, reportSale, type EetEnv } from "./reportSale";
import { matchAndFulfil, type VoucherOrderEnv } from "./voucherOrder";
import { resolveFio, DEFAULT_FIO_API_BASE, type FioEnvSource } from "./appConfig";

/** `FIO_TOKEN`, `FIO_POLL_INTERVAL_SECONDS` and `FIO_API_BASE` come in via `FioEnvSource`. */
export type FioEnv = EetEnv & VoucherOrderEnv & FioEnvSource;

type FioColumn = { value: unknown } | null | undefined;

export type FioTransaction = {
  /** `column22` — Fio's own unique transaction id; also the EET reference (`fio-<idPohyb>`). */
  idPohyb: string;
  amountCzk: number;
  /** `column14` — ISO 4217 code. This Worker only knows how to report CZK (see `runFioPollIfDue`). */
  currency: string | null;
  /** `column0` — the bank's posting date. What EET's `dat_trzby` should say. */
  dateIso: string | null;
  variableSymbol: string | null;
  /** `column4` — matched against the order's expected constant symbol. */
  constantSymbol: string | null;
  /** "Název protiúčtu" — the counterparty's name as registered with their bank. */
  senderName: string | null;
  /** "Zpráva pro příjemce" — the free-text note the payer attached to the transfer. */
  message: string | null;
};

/** A hung Fio endpoint shouldn't hold the cron open — see `submitToEet` for the same reasoning. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fio's JSON API returns `column0` ("Datum") as Unix epoch **milliseconds**
 * (the XML API renders the same field as "YYYY-MM-DD+HH:MM" — doc §5.3.1.6,
 * "Struktura TransactionList"). Returns null for anything unreadable, so the
 * caller falls back to "now" rather than writing a garbage timestamp into a
 * legal record.
 */
function fioDateToIso(value: unknown): string | null {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Fio's "last" endpoint returns only transactions since the previous
 * successful call — the bookmark is tracked server-side per token, so this
 * Worker doesn't need to persist a cursor of its own. An empty result leaves
 * the bookmark untouched, so polling on a fixed interval is always safe.
 * https://www.fio.cz/docs/cz/API_Bankovnictvi.pdf §5.2.3
 */
async function fetchNewFioTransactions(token: string, baseUrl: string): Promise<FioTransaction[]> {
  const res = await fetch(`${baseUrl}/last/${encodeURIComponent(token)}/transactions.json`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FIO_HTTP_${res.status}`);

  const body = (await res.json()) as {
    accountStatement?: { transactionList?: { transaction?: Record<string, FioColumn>[] } | null };
  };
  const rows = body.accountStatement?.transactionList?.transaction ?? [];

  // Column indices per the official "Struktura TransactionList" table (§5.3.1.6):
  // column0 = Datum, column22 = ID pohybu, column1 = Objem, column14 = Měna,
  // column4 = KS, column5 = VS, column10 = Název protiúčtu,
  // column16 = Zpráva pro příjemce.
  // Fio's JSON is inconsistent about whether numeric-looking fields come back
  // as JSON numbers or strings, so every value is coerced explicitly rather
  // than trusted to already be the right type.
  return rows.map((row) => ({
    idPohyb: row.column22?.value != null ? String(row.column22.value).trim() : "",
    amountCzk: Number(row.column1?.value ?? NaN),
    currency: row.column14?.value != null ? String(row.column14.value).trim().toUpperCase() : null,
    dateIso: fioDateToIso(row.column0?.value),
    variableSymbol: row.column5?.value != null ? String(row.column5.value).trim() : null,
    constantSymbol: row.column4?.value != null ? String(row.column4.value).trim() : null,
    senderName: row.column10?.value != null ? String(row.column10.value).trim() : null,
    message: row.column16?.value != null ? String(row.column16.value).trim() : null,
  }));
}

export type FioPollResult = { ranNow: boolean; reportedCount?: number; matchedCount?: number };

/**
 * Polls Fio for new bank transfers and does two things with each incoming
 * credit:
 *
 * 1. **Settles a voucher order**, if the payment's variable symbol, amount and
 *    constant symbol all match one that is waiting — which is what triggers the
 *    voucher PDF and its e-mail (see `lib/voucherOrder.ts`). Most credits match
 *    no order and fall straight through.
 * 2. **Registers the credit with EET**, exactly as before: every
 *    positive-amount CZK transaction is revenue, keyed by Fio's own `idPohyb`
 *    (`fio-<idPohyb>` reference). That reference is what makes the EET side
 *    idempotent — `reportSale` finds-or-creates by reference, so a transaction
 *    already seen (e.g. a retried poll after a partial failure) is never
 *    double-registered — and debit/outgoing transactions (negative amount) are
 *    skipped entirely. A voucher order being settled is *delivery on top of*
 *    the revenue registration, never a replacement for it.
 *
 * Runs at most once every `FIO_POLL_INTERVAL_SECONDS` (or always, when
 * `force` is set — see `POST /fio/poll`); throttling state lives in the
 * single-row `FioState` D1 table (migration `0002_fio_state.sql`).
 *
 * `opts.fetchTransactions` overrides where transactions come from, so the
 * matching can be exercised against a stub — the real Fio API is unreachable
 * from some environments (and always from `wrangler dev` in a sandbox).
 */
export async function runFioPollIfDue(
  env: FioEnv,
  opts: { force?: boolean; fetchTransactions?: (token: string) => Promise<FioTransaction[]> } = {},
): Promise<FioPollResult> {
  // Token, interval and the on/off switch come from the web configuration when
  // it overrides them, and from the environment otherwise — see lib/appConfig.ts.
  const fio = resolveFio(env, await db.getAppConfig(env.DB));
  if (!fio.enabled) {
    if (opts.force) throw new Error("FIO_NOT_CONFIGURED");
    return { ranNow: false };
  }

  const state = await db.getFioState(env.DB);
  const now = new Date();
  if (!opts.force && state.lastRunAt && now.getTime() - db.sqliteDatetimeMs(state.lastRunAt) < fio.intervalSeconds * 1000) {
    return { ranNow: false };
  }

  const apiBase = fio.apiBase.replace(/\/+$/, "");

  try {
    const fetchTransactions = opts.fetchTransactions ?? ((token: string) => fetchNewFioTransactions(token, apiBase));
    const transactions = await fetchTransactions(fio.token!);
    let reportedCount = 0;
    let matchedCount = 0;

    for (const txn of transactions) {
      if (!(txn.amountCzk > 0)) continue; // outgoing/debit transactions aren't revenue

      // EET's `celk_trzba` is always CZK, and this Worker has no exchange rate
      // to convert with, so a foreign-currency credit is skipped loudly rather
      // than reported at its face amount as if it were koruna. Fio marks Měna
      // as mandatory, so a null here is anomalous — also skip, never guess.
      if (txn.currency !== "CZK") {
        console.error(`Fio poll: skipping transaction ${txn.idPohyb} — currency is ${txn.currency ?? "missing"}, not CZK`);
        continue;
      }

      // Without an id there is no stable reference to key on: every such
      // transaction would collapse onto the single "fio-" row.
      if (!txn.idPohyb) {
        console.error(`Fio poll: skipping a ${txn.amountCzk} CZK transaction with no id_pohybu (column22)`);
        continue;
      }

      // Each transaction is handled independently — one unexpected failure here must not
      // abort the rest of the batch, since Fio's own "new since last call" bookmark has
      // already moved past every transaction in `transactions` by this point: anything not
      // finished processing now won't be returned by the next poll either.
      //
      // Delivery and EET registration are separate concerns and get separate error
      // handling: a failure to register the sale with EET must not swallow the voucher
      // the customer already paid for (and vice versa).
      try {
        const outcome = await matchAndFulfil(env, txn);
        if (outcome === "matched") matchedCount++;
      } catch (err) {
        console.error(
          `Fio poll: voucher order matching failed for transaction ${txn.idPohyb}:`,
          err instanceof Error ? err.message : String(err),
        );
      }

      const amountCzk = normalizeAmount(txn.amountCzk);
      if (amountCzk === null) {
        console.error(`Fio poll: transaction ${txn.idPohyb} has an out-of-range amount (${txn.amountCzk}), skipping`);
        continue;
      }

      const reference = `fio-${txn.idPohyb}`;
      try {
        const result = await reportSale(env, reference, amountCzk, { datTrzby: txn.dateIso ?? undefined });
        if (result.status === "sent") reportedCount++;

        // One line per credit, in Fio's own terms — observability is enabled for this
        // Worker, and this is the only place the payer details are ever available (EET
        // has nowhere to put them, and only the reference is kept in D1).
        console.log(
          `Fio poll: ${reference} ${amountCzk} CZK from ${txn.senderName ?? "unknown"}` +
            `${txn.variableSymbol ? ` (VS ${txn.variableSymbol})` : ""}` +
            `${txn.message ? ` "${txn.message}"` : ""} → ${result.status}`,
        );
      } catch (err) {
        console.error(`Fio poll: failed to report transaction ${txn.idPohyb}:`, err instanceof Error ? err.message : String(err));
      }
    }

    await db.updateFioState(env.DB, { lastRunAt: now.toISOString(), lastReportedCount: reportedCount, lastError: null, lastErrorAt: null });
    return { ranNow: true, reportedCount, matchedCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateFioState(env.DB, { lastRunAt: now.toISOString(), lastReportedCount: 0, lastError: message, lastErrorAt: now.toISOString() });
    throw err;
  }
}
