/**
 * Prague calendar days, and the UTC instants they begin and end at.
 *
 * This business runs on Prague time. Which day a sale belongs to, how long a
 * voucher is valid, what a customer would write on a form — all of it means the
 * Prague day, never a UTC one, and the two disagree for two hours of every
 * summer night. That is exactly the sort of hour a till is open in.
 *
 * The work is done by `Intl` — Workers ship full ICU — rather than a hand-rolled
 * DST table, which would be wrong twice a year in a way nobody would notice
 * until it mattered.
 */

export const PRAGUE_ZONE = "Europe/Prague";

export type CalendarDate = { year: number; month: number; day: number };

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Today's calendar date in Prague — the day the customer would write on the
 * voucher. `en-CA` formats as YYYY-MM-DD, which is the least painful to parse.
 */
export function pragueToday(now: Date = new Date()): CalendarDate {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: PRAGUE_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  return { year, month, day };
}

/** `YYYY-MM-DD`, the shape the API takes and hands back. */
export function formatDay(day: CalendarDate): string {
  const month = String(day.month).padStart(2, "0");
  const dayOfMonth = String(day.day).padStart(2, "0");
  return `${day.year}-${month}-${dayOfMonth}`;
}

/**
 * How far ahead of UTC Prague is at that instant, in milliseconds — an hour in
 * winter, two in summer.
 *
 * The trick is to render the instant in Prague and then read those wall-clock
 * numbers back as if they were UTC; the difference between the two is the
 * offset. Evaluated at a specific instant rather than "now", because the answer
 * changes twice a year and a range has two ends that can fall on either side.
 */
function pragueOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PRAGUE_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    // en-US renders midnight as hour 24.
    value("hour") % 24,
    value("minute"),
    value("second"),
  );
  return asIfUtc - at.getTime();
}

/** The instant a Prague calendar day starts, as an ISO-8601 UTC string. */
function pragueMidnightUtc(year: number, month: number, dayOfMonth: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, dayOfMonth));
  // The offset is read at the guess — UTC midnight of that date — rather than at
  // the true local midnight a couple of hours earlier. Both switch days put the
  // change at 01:00 UTC, so the two agree; anything else would need a second
  // correction pass.
  return new Date(guess.getTime() - pragueOffsetMs(guess));
}

/**
 * The half-open UTC range `[from, to)` that one Prague calendar day covers, as
 * ISO-8601 strings ready to be compared against the `datetime(...)` SQLite
 * stores.
 *
 * `null` for anything that is not a real `YYYY-MM-DD` date — `2026-02-30` among
 * them, which the ISO parser rejects rather than silently rolling over into
 * March.
 */
export function pragueDayRangeUtc(day: string): { from: string; to: string } | null {
  const match = DAY_RE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);

  // The parts are checked to have survived being made into a date, because a
  // date that does not exist is not rejected by the parser: "2026-02-30" rolls
  // quietly over into March, and a range for a day nobody asked for is worse
  // than a 400.
  const startOfDay = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    startOfDay.getUTCFullYear() !== year ||
    startOfDay.getUTCMonth() !== month - 1 ||
    startOfDay.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }

  const start = pragueMidnightUtc(year, month, dayOfMonth);
  const nextDay = new Date(Date.UTC(year, month - 1, dayOfMonth + 1));
  const end = pragueMidnightUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate());

  return { from: start.toISOString(), to: end.toISOString() };
}
