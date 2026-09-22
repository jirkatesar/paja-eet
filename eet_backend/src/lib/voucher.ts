import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import voucherTemplate from "../../assets/poukazka.pdf";
import { pragueToday, type CalendarDate } from "./pragueTime";

/**
 * Fills the blank gift-voucher template (`assets/poukazka.pdf`) with the
 * amount, the voucher number, and a "valid until" date six months out.
 *
 * The three blanks are gaps the template deliberately leaves in its own text
 * runs, so the values are simply drawn into them — the template's labels,
 * layout, and artwork are untouched. Coordinates below are in PDF points,
 * measured from the page's bottom-left corner (pdf-lib's convention), and
 * were derived from the template's own glyph metrics rather than eyeballed:
 * each is the exact pen position the removed text used to occupy, which is
 * why nothing around them shifts.
 */

/**
 * The gap after "…V HODNOTĚ " in the title (baseline y, /F1 at 18pt).
 * The amount is right-aligned to `xEnd` so it always touches the template's
 * own ",-Kč", exactly as the original "1000,-Kč" did.
 *
 * `xStart`–`xEnd` is that gap: 36pt, i.e. exactly four digits at 18pt. A
 * longer amount (15000, say) would otherwise grow *leftward* out of the gap
 * and collide with the "HODNOTĚ" in front of it, so anything wider than the
 * gap is drawn at a proportionally smaller size instead — see `fillVoucher`.
 */
const AMOUNT_FIELD = { xStart: 447.158, xEnd: 483.158, y: 769.139, size: 18 } as const;

/** The gap after "Číslo poukazu:  " (baseline y, /F1 at 12pt). Left-aligned; the run of spaces that follows absorbs a longer number. */
const NUMBER_FIELD = { x: 129.714, y: 508.189, size: 12 } as const;

/** The gap after "Platnost do:  " (baseline y, /F1 at 12pt). Left-aligned, same reasoning as the number. */
const VALID_UNTIL_FIELD = { x: 318.666, y: 508.189, size: 12 } as const;

/** How long a voucher stays redeemable — the template's own footnote says "6 měsíců od data vystavení". */
const VALIDITY_MONTHS = 6;

export type VoucherParams = {
  /** Whole crowns; rendered without separators, e.g. 1000 → "1000". */
  amountCzk: number;
  /** The operator's own voucher number — printed as given, and conventionally used as the payment's variable symbol. */
  voucherNumber: string | number;
  /** When the voucher is issued. Defaults to now; passed explicitly only to backdate. */
  issuedOn?: Date;
};

/**
 * `date` shifted by whole months, clamping to the end of the target month:
 * 31 Aug + 6 months is 28 (or 29) Feb, not 3 March. Clamping is the
 * behaviour Czech date arithmetic expects — and what `Date.setMonth` gets
 * wrong by overflowing into the next month.
 */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const zeroBased = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  // Day 0 of the following month is the last day of this one; Date handles leap years.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(date.day, lastDay) };
}

/** "30. 9. 2024" — the template's own format: no zero padding, dots, spaces. */
export function formatCzechDate(date: CalendarDate): string {
  return `${date.day}. ${date.month}. ${date.year}`;
}

/**
 * The voucher's "Platnost do" value: six months after `issuedOn` (or today),
 * phrased as a date string ready to draw.
 */
export function computeValidUntil(issuedOn?: Date): string {
  return formatCzechDate(addMonths(pragueToday(issuedOn), VALIDITY_MONTHS));
}

function formatAmount(amountCzk: number): string {
  if (!Number.isFinite(amountCzk) || amountCzk <= 0) {
    throw new Error("amountCzk must be a positive number");
  }
  const rounded = Math.round(amountCzk * 100) / 100;
  // The template already prints ",-Kč" right after this field, so whole
  // crowns are the intended use; haléře are still rendered rather than
  // silently dropped, with the Czech decimal comma.
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(".", ",");
}

function formatVoucherNumber(voucherNumber: string | number): string {
  const text = String(voucherNumber).trim();
  if (!text) throw new Error("voucherNumber must not be empty");
  return text;
}

/**
 * Returns a copy of the voucher template with `amountCzk`, `voucherNumber`
 * and the computed validity date filled in.
 *
 * The template is passed in (defaulting to the bundled one) so callers can
 * render a different layout, and so tests can supply bytes directly.
 */
export async function fillVoucher(
  params: VoucherParams,
  template: ArrayBuffer | Uint8Array = voucherTemplate,
): Promise<Uint8Array> {
  const amount = formatAmount(params.amountCzk);
  const number = formatVoucherNumber(params.voucherNumber);
  const validUntil = computeValidUntil(params.issuedOn);

  const doc = await PDFDocument.load(template);
  // Times-Roman rather than an embedded file: it is one of the base-14 fonts
  // every PDF viewer already has, and its metrics are identical to the
  // template's own Liberation Serif for every character drawn here (digits
  // 500/1000 em, period and space 250) — so the values line up with the
  // surrounding text exactly, with no font embedded just to print a date.
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.getPage(0);

  // Widths scale linearly with font size, so one ratio gives the largest size
  // at which the amount still fits the blank — 18pt for up to four digits,
  // smaller beyond that rather than overlapping the title text.
  const blankWidth = AMOUNT_FIELD.xEnd - AMOUNT_FIELD.xStart;
  const widthAtFullSize = font.widthOfTextAtSize(amount, AMOUNT_FIELD.size);
  const amountSize =
    widthAtFullSize <= blankWidth ? AMOUNT_FIELD.size : AMOUNT_FIELD.size * (blankWidth / widthAtFullSize);

  page.drawText(amount, {
    x: AMOUNT_FIELD.xEnd - font.widthOfTextAtSize(amount, amountSize),
    y: AMOUNT_FIELD.y,
    size: amountSize,
    font,
    color: rgb(0, 0, 0),
  });

  page.drawText(number, { x: NUMBER_FIELD.x, y: NUMBER_FIELD.y, size: NUMBER_FIELD.size, font, color: rgb(0, 0, 0) });
  page.drawText(validUntil, {
    x: VALID_UNTIL_FIELD.x,
    y: VALID_UNTIL_FIELD.y,
    size: VALID_UNTIL_FIELD.size,
    font,
    color: rgb(0, 0, 0),
  });

  return doc.save();
}
