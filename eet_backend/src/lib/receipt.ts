import type { PaymentOrderRow } from "./db";

/**
 * The receipt block that goes into the e-mail after a payment: the date and the
 * amount for services.
 *
 * It is a *block*, not a message of its own, because an order sends exactly one
 * e-mail — the voucher's, with the receipt appended, or the receipt alone. Two
 * separate mails would mean two things that can independently fail, and the
 * retry loop only knows "sent" or "not sent": a failing receipt would resend
 * the voucher with every attempt, and the customer would end up with a mailbox
 * full of them.
 *
 * **This is a stand-in, not a tax document**, and it says so. A document that
 * looks like an invoice but isn't one is worse than no document, and whoever
 * receives it should not file it. Replace this once an accountant has said what
 * a real receipt has to contain — nothing around it depends on the wording.
 */

/** "14. 9. 2026" — the same format the voucher template uses. */
function formatDate(date: Date): string {
  return `${date.getDate()}. ${date.getMonth() + 1}. ${date.getFullYear()}`;
}

function formatAmount(amountCzk: string): string {
  const amount = Number(amountCzk);
  if (!Number.isFinite(amount)) return amountCzk;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(".", ",");
}

/**
 * The date the receipt is for: when the money arrived, falling back to when the
 * order was placed. Both are D1 timestamps ("YYYY-MM-DD HH:MM:SS", UTC), which
 * `new Date` will not parse as-is.
 */
export function receiptDate(order: PaymentOrderRow): Date {
  const stamp = order.paidAt ?? order.createdAt;
  const parsed = new Date(`${stamp.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** Subject for an order that is only a receipt — a voucher keeps its own subject. */
export const RECEIPT_SUBJECT = "Účet za služby";

const RULE = "--------------------------------";

/** The receipt as a block of plain text, ready to be pasted into a message body. */
export function receiptBlock(order: PaymentOrderRow): string {
  return [
    RULE,
    "ÚČET ZA SLUŽBY",
    RULE,
    `Datum:  ${formatDate(receiptDate(order))}`,
    `Částka: ${formatAmount(order.amountCzk)} Kč`,
    RULE,
    "",
    "Paja Masáže",
    "Pavlína Tesařová",
    "Tel.: 608 565 402",
    "Bezručova čtvrť 1116, Kuřim",
    "",
    "Toto je TESTOVACÍ účet, nejde o daňový doklad.",
  ].join("\r\n");
}
