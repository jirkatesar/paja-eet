import * as db from "./db";
import type { PaymentKind, PaymentOrderRow } from "./db";
import { normalizeAmount } from "./reportSale";
import { fillVoucher } from "./voucher";
import { sendMail, type SmtpConfig } from "./smtp";
import { resolveSmtp, type SmtpEnvSource } from "./appConfig";
import { RECEIPT_SUBJECT, receiptBlock } from "./receipt";

/**
 * Payment orders: the app creates one for every sale, and when the money is in
 * the customer gets an e-mail — the receipt, plus the voucher itself for a
 * voucher purchase.
 *
 * Settlement happens immediately for cash, or once the Fio poll matches the
 * incoming bank transfer. Matching is by variable symbol, which every transfer
 * now carries: for a voucher it is the manually entered voucher number, for a
 * service the app generates one. Uniqueness of that symbol is what stops two
 * live orders sharing it — see the partial unique index in migration 0005.
 *
 * `kind` decides what is sent: VOUCHER also gets the PDF, SERVICE only the
 * receipt.
 */

export interface PaymentOrderEnv extends SmtpEnvSource {
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

export function orderTtlDays(env: PaymentOrderEnv): number {
  const days = Number(env.VOUCHER_ORDER_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.trunc(days) : DEFAULT_ORDER_TTL_DAYS;
}

// ---------------------------------------------------------------- ordering

export type CreateOrderInput = {
  amountCzk?: unknown;
  variableSymbol?: unknown;
  email?: unknown;
  /** `true` = paid at the counter, so the mail goes out immediately. */
  cash?: unknown;
  constantSymbol?: unknown;
  /** `VOUCHER` (default) or `SERVICE` — what gets sent once the money is in. */
  kind?: unknown;
};

export type CreateOrderResult = { ok: true; order: PaymentOrderRow } | { ok: false; status: number; error: string };

/**
 * Validates and records an order. For `cash`, it also delivers right away — the
 * order is created `PAID` rather than `PENDING`, so if this process dies before
 * the mail goes out, the cron's delivery retry owns it instead of the order
 * quietly waiting for a bank payment that will never come.
 *
 * A failed *delivery* is deliberately not a failed request: the order and any
 * PDF exist, only the mail is pending, and the response says `PAID` so the
 * caller can tell the operator it will be sent.
 *
 * `kind` defaults to `VOUCHER` so a client that predates services — the version
 * of the Android app already installed — keeps working unchanged.
 */
export async function createPaymentOrder(env: PaymentOrderEnv, input: CreateOrderInput): Promise<CreateOrderResult> {
  // Shared with /report on purpose: a voucher amount is a CZK revenue amount and
  // is later handed to EET, so it has to satisfy the same bounds and the same
  // two-decimal shape.
  const amountCzk = normalizeAmount(input.amountCzk);
  if (amountCzk === null) return { ok: false, status: 400, error: "amountCzk must be a positive number below 100000000" };

  const cash = input.cash === undefined ? false : input.cash;
  if (typeof cash !== "boolean") return { ok: false, status: 400, error: "cash must be true or false" };

  const kindInput = input.kind === undefined ? "VOUCHER" : input.kind;
  if (kindInput !== "VOUCHER" && kindInput !== "SERVICE") return { ok: false, status: 400, error: "kind must be VOUCHER or SERVICE" };
  const kind: PaymentKind = kindInput;

  const variableSymbol =
    typeof input.variableSymbol === "number" || typeof input.variableSymbol === "string" ? String(input.variableSymbol).trim() : "";
  if (!VS_RE.test(variableSymbol)) return { ok: false, status: 400, error: "variableSymbol must be 1 to 10 digits" };

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: "email must be a valid e-mail address" };

  // Every transfer carries a constant symbol, whatever it is for — the QR for a
  // massage uses the services one, a voucher the voucher one. Storing it keeps
  // matching exact; leaving it out would mean a payment that agrees on symbol
  // and amount but was sent with a different KS still settled the order.
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

  let order: PaymentOrderRow;
  try {
    order = await db.insertPaymentOrder(env.DB, {
      variableSymbol,
      vsNormalized: normalizeSymbol(variableSymbol),
      amountCzk,
      constantSymbol,
      email,
      kind,
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
    return { ok: true, order: (await db.getPaymentOrder(env.DB, order.id)) ?? order };
  }

  return { ok: true, order };
}

// ---------------------------------------------------------------- delivery

function formatAmount(amountCzk: string): string {
  const amount = Number(amountCzk);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(".", ",");
}

/**
 * The message for a settled order: one e-mail carrying the receipt, with the
 * voucher attached when there is one.
 *
 * A voucher purchase gets both in a single message on purpose — see the note in
 * `receipt.ts`: two e-mails would be two things that can fail independently,
 * and the retry loop only knows sent from not-sent.
 */
function orderMail(order: PaymentOrderRow): { subject: string; text: string } {
  const body: string[] = ["Dobrý den,", ""];

  if (order.kind === "VOUCHER") {
    body.push(
      `v příloze Vám posíláme dárkový poukaz na masáž v hodnotě ${formatAmount(order.amountCzk)} Kč, ` +
        `číslo poukazu ${order.variableSymbol}.`,
      "",
      "Platnost poukazu je 6 měsíců od data vystavení. Poukaz nelze směnit za peníze, ani nelze vrátit hotovost.",
      "",
    );
  } else {
    body.push("děkujeme za platbu.", "");
  }

  body.push(receiptBlock(order));

  return {
    subject:
      order.kind === "VOUCHER" ? `Dárkový poukaz na masáž č. ${order.variableSymbol}` : RECEIPT_SUBJECT,
    text: body.join("\r\n"),
  };
}

/**
 * Sends the order's mail. On failure the order stays `PAID` with `lastError`
 * recorded and the cron retries — the money did arrive, so losing the delivery
 * would be the one outcome worth avoiding.
 */
export async function fulfilOrder(env: PaymentOrderEnv, order: PaymentOrderRow): Promise<boolean> {
  try {
    const mail = orderMail(order);
    const attachment =
      order.kind === "VOUCHER"
        ? {
            filename: `poukaz-${order.variableSymbol}.pdf`,
            bytes: await fillVoucher({ amountCzk: Number(order.amountCzk), voucherNumber: order.variableSymbol }),
            contentType: "application/pdf",
          }
        : undefined;

    // Mail settings come from the web configuration when it overrides them, and
    // from the environment otherwise — see lib/appConfig.ts.
    const smtp = resolveSmtp(env, await db.getAppConfig(env.DB)).config;
    await sendMail(smtp, {
      to: order.email,
      subject: mail.subject,
      text: mail.text,
      attachment: attachment,
    });
    await db.markOrderSent(env.DB, order.id);
    console.log(`Order ${order.id} (${order.kind}, VS ${order.variableSymbol}) sent to ${order.email}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.markOrderSendFailed(env.DB, order.id, message);
    console.error(`Order ${order.id} (${order.kind}, VS ${order.variableSymbol}) delivery failed:`, message);
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
export function classifyTransaction(order: PaymentOrderRow, payment: IncomingPayment): MatchOutcome {
  if (!amountsEqual(order.amountCzk, payment.amountCzk)) return "amount_mismatch";
  // An order with no constant symbol has nothing to compare — a cash order never
  // reaches here, so this is only a caller that did not send one. Comparing
  // against the empty string would make such an order unmatchable.
  if (order.constantSymbol && order.constantSymbol !== normalizeSymbol(payment.constantSymbol ?? "")) return "ks_mismatch";
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
export async function matchAndFulfil(env: PaymentOrderEnv, payment: IncomingPayment): Promise<MatchOutcome> {
  const symbol = payment.variableSymbol?.trim();
  if (!symbol) return "no_order";

  const order = await db.findPendingPaymentOrder(env.DB, normalizeSymbol(symbol));
  if (!order) return "no_order";

  const outcome = classifyTransaction(order, payment);
  if (outcome !== "matched") {
    const detail =
      outcome === "amount_mismatch"
        ? `expected ${order.amountCzk} CZK, payment was ${payment.amountCzk} CZK`
        : `expected KS ${order.constantSymbol}, payment had ${payment.constantSymbol ?? "(none)"}`;
    console.error(
      `Order ${order.id} (${order.kind}, VS ${order.variableSymbol}) not settled by transaction ${payment.idPohyb} — ${detail}`,
    );
    return outcome;
  }

  await db.markOrderPaid(env.DB, order.id, payment.idPohyb);
  console.log(`Order ${order.id} (${order.kind}, VS ${order.variableSymbol}) settled by transaction ${payment.idPohyb}`);
  await fulfilOrder(env, order);
  return "matched";
}

/** Retries delivery for orders whose money arrived but whose mail never went out. */
export async function retryDeliveries(env: PaymentOrderEnv, limit = 10): Promise<number> {
  const orders = await db.listOrdersToSend(env.DB, limit);
  let sent = 0;
  for (const order of orders) {
    if (await fulfilOrder(env, order)) sent++;
  }
  return sent;
}
