import * as db from "./db";
import type { VoucherOrderRow } from "./db";
import { normalizeAmount } from "./reportSale";
import { fillVoucher } from "./voucher";
import { sendMail, type SmtpConfig } from "./smtp";
import { resolveSmtp, type SmtpEnvSource } from "./appConfig";

/**
 * Voucher orders: the app creates one, and the voucher is generated and
 * e-mailed when the order is settled — immediately for cash, or once the Fio
 * poll matches the incoming bank transfer.
 *
 * The variable symbol is the voucher number (that is what the customer's
 * payment carries, and what gets printed on the PDF), so uniqueness of the
 * symbol is what stops two vouchers sharing a number — see the partial unique
 * index in migration 0003.
 */

export interface VoucherOrderEnv extends SmtpEnvSource {
  DB: D1Database;
  /** Fallback constant symbol for transfer orders whose call omitted one. */
  VOUCHER_KS?: string;
  /** Days an unpaid order holds its variable symbol before expiring. */
  VOUCHER_ORDER_TTL_DAYS?: string;
}

const DEFAULT_ORDER_TTL_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VS_RE = /^\d{1,10}$/;
const KS_RE = /^\d{1,4}$/;

/**
 * Digits with leading zeros dropped, but never down to nothing: Fio hands back
 * "0007" for a symbol the app recorded as "7", and a naive string compare would
 * mean that payment never matched its order.
 */
export function normalizeSymbol(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}

// ------------------------------------------------------------- configuration

export function voucherOrderTtlDays(env: VoucherOrderEnv): number {
  const days = Number(env.VOUCHER_ORDER_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.trunc(days) : DEFAULT_ORDER_TTL_DAYS;
}

// ---------------------------------------------------------------- ordering

export type CreateOrderInput = {
  amountCzk?: unknown;
  variableSymbol?: unknown;
  email?: unknown;
  /** `true` = paid at the counter, so the voucher goes out immediately. */
  cash?: unknown;
  constantSymbol?: unknown;
};

export type CreateOrderResult = { ok: true; order: VoucherOrderRow } | { ok: false; status: number; error: string };

/**
 * Validates and records an order. For `cash`, it also delivers the voucher
 * right away — the order is created `PAID` rather than `PENDING`, so if this
 * process dies before the mail goes out, the cron's delivery retry owns it
 * instead of the order quietly waiting for a bank payment that will never come.
 *
 * A failed *delivery* is deliberately not a failed request: the order and the
 * PDF exist, only the mail is pending, and the response says `PAID` so the
 * caller can tell the operator it will be sent.
 */
export async function createVoucherOrder(env: VoucherOrderEnv, input: CreateOrderInput): Promise<CreateOrderResult> {
  // Shared with /report on purpose: a voucher amount is a CZK revenue amount and
  // is later handed to EET, so it has to satisfy the same bounds and the same
  // two-decimal shape.
  const amountCzk = normalizeAmount(input.amountCzk);
  if (amountCzk === null) return { ok: false, status: 400, error: "amountCzk must be a positive number below 100000000" };

  const cash = input.cash === undefined ? false : input.cash;
  if (typeof cash !== "boolean") return { ok: false, status: 400, error: "cash must be true or false" };

  const variableSymbol =
    typeof input.variableSymbol === "number" || typeof input.variableSymbol === "string" ? String(input.variableSymbol).trim() : "";
  if (!VS_RE.test(variableSymbol)) return { ok: false, status: 400, error: "variableSymbol must be 1 to 10 digits" };

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: "email must be a valid e-mail address" };

  let constantSymbol = "";
  if (!cash) {
    const given =
      typeof input.constantSymbol === "string" || typeof input.constantSymbol === "number"
        ? String(input.constantSymbol).trim()
        : "";
    const chosen = given || (env.VOUCHER_KS ?? "").trim();
    // Failing loudly beats storing an order that can never match a payment.
    if (!chosen) return { ok: false, status: 400, error: "voucher_ks_not_configured" };
    if (!KS_RE.test(chosen)) return { ok: false, status: 400, error: "constantSymbol must be 1 to 4 digits" };
    constantSymbol = normalizeSymbol(chosen);
  }

  let order: VoucherOrderRow;
  try {
    order = await db.insertVoucherOrder(env.DB, {
      variableSymbol,
      vsNormalized: normalizeSymbol(variableSymbol),
      amountCzk,
      constantSymbol,
      email,
      paymentMethod: cash ? "CASH" : "TRANSFER",
      status: cash ? "PAID" : "PENDING",
    });
  } catch (err) {
    // Relying on the index rather than a prior SELECT is what makes this safe
    // against two concurrent calls for the same symbol.
    if (db.isDuplicateVariableSymbol(err)) return { ok: false, status: 409, error: "variable_symbol_already_used" };
    throw err;
  }

  if (cash) {
    await fulfilOrder(env, order);
    // Re-read rather than returning the row as inserted: a failed delivery
    // leaves it PAID with `lastError` set, and the caller needs to see that
    // instead of a stale, error-free copy.
    return { ok: true, order: (await db.getVoucherOrder(env.DB, order.id)) ?? order };
  }

  return { ok: true, order };
}

// ---------------------------------------------------------------- delivery

function emailBody(order: VoucherOrderRow): string {
  const amount = Number(order.amountCzk);
  const formatted = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(".", ",");
  return [
    "Dobrý den,",
    "",
    `v příloze Vám posíláme dárkový poukaz na masáž v hodnotě ${formatted} Kč, číslo poukazu ${order.variableSymbol}.`,
    "",
    "Platnost poukazu je 6 měsíců od data vystavení. Poukaz nelze směnit za peníze, ani nelze vrátit hotovost.",
    "",
    "S pozdravem",
  ].join("\r\n");
}

/**
 * Generates the voucher and mails it. On failure the order stays `PAID` with
 * `lastError` recorded and the cron retries — the money did arrive, so losing
 * the delivery would be the one outcome worth avoiding.
 */
export async function fulfilOrder(env: VoucherOrderEnv, order: VoucherOrderRow): Promise<boolean> {
  try {
    const pdf = await fillVoucher({ amountCzk: Number(order.amountCzk), voucherNumber: order.variableSymbol });
    // Mail settings come from the web configuration when it overrides them, and
    // from the environment otherwise — see lib/appConfig.ts.
    const smtp = resolveSmtp(env, await db.getAppConfig(env.DB)).config;
    await sendMail(smtp, {
      to: order.email,
      subject: `Dárkový poukaz na masáž č. ${order.variableSymbol}`,
      text: emailBody(order),
      attachment: {
        filename: `poukaz-${order.variableSymbol}.pdf`,
        bytes: pdf,
        contentType: "application/pdf",
      },
    });
    await db.markVoucherSent(env.DB, order.id);
    console.log(`Voucher order ${order.id} (VS ${order.variableSymbol}) sent to ${order.email}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.markVoucherSendFailed(env.DB, order.id, message);
    console.error(`Voucher order ${order.id} (VS ${order.variableSymbol}) delivery failed:`, message);
    return false;
  }
}

// ---------------------------------------------------------------- matching

/** The slice of a Fio transaction that order matching needs. */
export type IncomingPayment = {
  idPohyb: string;
  variableSymbol: string | null;
  constantSymbol: string | null;
  amountCzk: number;
};

export type MatchOutcome = "no_order" | "matched" | "amount_mismatch" | "ks_mismatch";

function amountsEqual(expected: string, actual: number): boolean {
  const left = Number(expected);
  return Number.isFinite(left) && Number.isFinite(actual) && Math.round(left * 100) === Math.round(actual * 100);
}

/** Whether an incoming payment settles `order` — all three of VS, amount and KS have to line up. */
export function classifyTransaction(order: VoucherOrderRow, payment: IncomingPayment): MatchOutcome {
  if (!amountsEqual(order.amountCzk, payment.amountCzk)) return "amount_mismatch";
  if (order.constantSymbol !== normalizeSymbol(payment.constantSymbol ?? "")) return "ks_mismatch";
  return "matched";
}

/**
 * Tries to settle a pending order with an incoming bank payment. Called for
 * every credit the Fio poll sees; almost all of them have no order and return
 * "no_order" immediately.
 *
 * A symbol that matches while the amount or constant symbol does not is logged
 * rather than swallowed: an underpayment is exactly the case where the customer
 * believes they have paid and nobody would otherwise notice.
 */
export async function matchAndFulfil(env: VoucherOrderEnv, payment: IncomingPayment): Promise<MatchOutcome> {
  const symbol = payment.variableSymbol?.trim();
  if (!symbol) return "no_order";

  const order = await db.findPendingVoucherOrder(env.DB, normalizeSymbol(symbol));
  if (!order) return "no_order";

  const outcome = classifyTransaction(order, payment);
  if (outcome !== "matched") {
    const detail =
      outcome === "amount_mismatch"
        ? `expected ${order.amountCzk} CZK, payment was ${payment.amountCzk} CZK`
        : `expected KS ${order.constantSymbol}, payment had ${payment.constantSymbol ?? "(none)"}`;
    console.error(
      `Voucher order ${order.id} (VS ${order.variableSymbol}) not settled by transaction ${payment.idPohyb} — ${detail}`,
    );
    return outcome;
  }

  await db.markVoucherPaid(env.DB, order.id, payment.idPohyb);
  console.log(`Voucher order ${order.id} (VS ${order.variableSymbol}) settled by transaction ${payment.idPohyb}`);
  await fulfilOrder(env, order);
  return "matched";
}

/** Retries delivery for orders whose money arrived but whose voucher never went out. */
export async function retryVoucherDeliveries(env: VoucherOrderEnv, limit = 10): Promise<number> {
  const orders = await db.listVoucherOrdersToSend(env.DB, limit);
  let sent = 0;
  for (const order of orders) {
    if (await fulfilOrder(env, order)) sent++;
  }
  return sent;
}
