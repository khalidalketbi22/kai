/**
 * Date helpers. All dates are 'YYYY-MM-DD' strings, handled as UTC calendar days so there is
 * no timezone drift. "Today" is computed in Asia/Dubai.
 */

export type ISODate = string;

export function todayInDubai(now = new Date()): ISODate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const toUtc = (d: ISODate): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Bad date: ${d}`);
  return new Date(`${d}T00:00:00Z`);
};
const fromUtc = (d: Date): ISODate => d.toISOString().slice(0, 10);

export function addDays(d: ISODate, n: number): ISODate {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromUtc(x);
}

/** Inclusive number of days from a to b (a ≤ b). */
export function daysBetweenInclusive(a: ISODate, b: ISODate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000) + 1;
}

export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 0 = Sunday … 6 = Saturday */
export const dayOfWeek = (d: ISODate): number => toUtc(d).getUTCDay();

/**
 * The Liwan's business month runs from the 8th to the 7th (staff are paid on the 8th).
 * e.g. 2026-11-01 → { start: 2026-10-08, end: 2026-11-07, days: 31 }
 */
export function businessMonth(d: ISODate, startDay = 8): { start: ISODate; end: ISODate; days: number } {
  const x = toUtc(d);
  let y = x.getUTCFullYear();
  let m = x.getUTCMonth();
  if (x.getUTCDate() < startDay) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const start = new Date(Date.UTC(y, m, startDay));
  const end = new Date(Date.UTC(y, m + 1, startDay - 1));
  const s = fromUtc(start), e = fromUtc(end);
  return { start: s, end: e, days: daysBetweenInclusive(s, e) };
}

/** Monday→Sunday week ending on the given date (the weekly report runs on Sunday). */
export function weekEnding(sunday: ISODate): { start: ISODate; end: ISODate } {
  return { start: addDays(sunday, -6), end: sunday };
}

/** Whole months elapsed between two dates (fractional), used for payback pacing. */
export function monthsBetween(a: ISODate, b: ISODate): number {
  return (daysBetweenInclusive(a, b) - 1) / (365.25 / 12);
}

export function addMonths(d: ISODate, n: number): ISODate {
  const x = toUtc(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, lastDay));
  return fromUtc(x);
}
