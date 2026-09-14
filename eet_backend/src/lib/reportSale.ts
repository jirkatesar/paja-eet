import { buildSignedEnvelope, certPemToDerBase64, importPrivateKeyFromPem, nowIso } from "./xmlsign";
import { submitToEet } from "./eetClient";
import * as db from "./db";
import type { EetSaleRow } from "./db";

export interface EetEnv {
  DB: D1Database;
  EET_CERT_PEM: string;
  EET_PRIVATE_KEY_PEM: string;
  EET_EIC: string;
  EET_ID_JEDNOTKY: string;
  EET_ID_POKL: string;
  EET_ENDPOINT: string;
}

export type ReportOutcome = {
  status: "sent" | "pending" | "expired" | "rejected";
  pok: string | null;
  test: boolean;
  errorCode: number | null;
  errorMessage?: string | null;
};

/** Positive amount, 2 decimal places, within EET's CastkaType range. Returns null if invalid. */
export function normalizeAmount(input: unknown): string | null {
  const n = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n >= 100_000_000) return null;
  return n.toFixed(2);
}

/**
 * Attempts one registration for `row`. On success marks it SENT. On *any*
 * failure — network error, unparseable response, transient EET codes
 * -1..-999, or an EET protocol-level rejection (bad schema/signature/EIC/
 * size) — it stays PENDING and gets retried by the cron, same treatment for
 * both: the caller can't act on an immediate hard failure either way, so
 * there's nothing to gain from giving up early. The only thing that ends
 * automatic retry is success or the 48h ZoET deadline (see `scheduled()` in
 * index.ts, which marks it EXPIRED at that point).
 */
export async function attemptSubmit(env: EetEnv, row: EetSaleRow, prvniZaslani: boolean): Promise<ReportOutcome> {
  try {
    const key = await importPrivateKeyFromPem(env.EET_PRIVATE_KEY_PEM);
    const certDer = certPemToDerBase64(env.EET_CERT_PEM);
    const envelope = await buildSignedEnvelope(
      {
        uuidZpravy: crypto.randomUUID(),
        datOdesl: nowIso(),
        prvniZaslani,
        eicPopl: row.eic,
        idJednotky: row.idJednotky,
        idPokl: row.idPokl,
        poradCis: String(row.id),
        datTrzby: row.datTrzby,
        celkTrzba: row.amountCzk,
      },
      certDer,
      key,
    );

    const result = await submitToEet(envelope, env.EET_ENDPOINT);

    if (result.ok) {
      await db.markSent(env.DB, row.id, result.pok!, Boolean(result.test));
      return { status: "sent", pok: result.pok!, test: Boolean(result.test), errorCode: null };
    }

    await db.markAttemptFailed(env.DB, row.id, result.errorCode ?? null, result.errorMessage ?? result.raw.slice(0, 500));
    return { status: "pending", pok: null, test: false, errorCode: result.errorCode ?? null };
  } catch (err) {
    // Anything unexpected (e.g. malformed key config) is treated the same way so it doesn't wedge the queue silently.
    await db.markAttemptFailed(env.DB, row.id, null, err instanceof Error ? err.message : String(err));
    return { status: "pending", pok: null, test: false, errorCode: null };
  }
}

/**
 * Finds-or-creates the `EetSale` row for `reference` and attempts one
 * registration if it isn't already terminal (`SENT`/`EXPIRED`/`REJECTED`).
 * Shared by the `POST /report` endpoint and the Fio poll (`lib/fio.ts`) so
 * both paths get the exact same idempotent find-or-insert + immediate-attempt
 * behavior — resubmitting the same reference either replays the stored
 * result or retries immediately, never double-registers.
 *
 * `opts.datTrzby` lets a caller that knows the real sale time pass it in
 * instead of defaulting to "now" — the Fio poll does, since a bank transfer
 * carries the bank's own posting date and the sale it represents may be
 * hours or days older than the poll that noticed it. It only applies when
 * this call is the one creating the row: on an existing row the stored
 * `datTrzby` always wins, because it's part of the composite EET uses to
 * recognize a resubmission of the same sale (see README).
 */
export async function reportSale(
  env: EetEnv,
  reference: string,
  amountCzk: string,
  opts: { datTrzby?: string } = {},
): Promise<ReportOutcome> {
  let row = await db.findByReference(env.DB, reference);
  let isNew = false;
  if (!row) {
    try {
      row = await db.insertPending(env.DB, {
        reference,
        amountCzk,
        eic: env.EET_EIC,
        idJednotky: env.EET_ID_JEDNOTKY,
        idPokl: env.EET_ID_POKL,
        datTrzby: opts.datTrzby ?? nowIso(),
      });
      isNew = true;
    } catch {
      // Lost a race against a concurrent call for the same reference — fall back to whatever it left behind.
      row = await db.findByReference(env.DB, reference);
      if (!row) throw new Error("internal_error");
    }
  }

  if (row.status === "SENT") {
    return { status: "sent", pok: row.pok, test: Boolean(row.test), errorCode: null };
  }
  // REJECTED is no longer written by attemptSubmit (see its comment) — this branch only
  // serves rows created before that change; kept so old REJECTED rows still read back sanely.
  if (row.status === "REJECTED") {
    return { status: "rejected", pok: null, test: false, errorCode: row.lastErrorCode, errorMessage: row.lastErrorMessage };
  }
  if (row.status === "EXPIRED") {
    return { status: "expired", pok: null, test: false, errorCode: row.lastErrorCode, errorMessage: row.lastErrorMessage };
  }

  return attemptSubmit(env, row, isNew);
}
