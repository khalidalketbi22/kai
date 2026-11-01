/**
 * Shift rota — pure functions.
 *
 *   shiftMinutes()      working minutes of a shift (break excluded, can run past midnight)
 *   nightMinutes()      minutes worked between 22:00 and 04:00 (for the night overtime premium)
 *   generateRota()      one week of shifts from templates, respecting rest days and weekly hour caps
 *   rotaWarnings()      checks: daily hours, weekly hours, a rest day every week
 */
import { addDays, dayOfWeek, type ISODate } from "./periods.js";

export interface ShiftTemplate { code: string; label: string; start: string; end: string; break: number }

const toMin = (hhmm: string): number => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`Bad time "${hhmm}" (use HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Span of a shift in minutes; an end at or before the start means it finishes after midnight. */
export function spanMinutes(start: string, end: string): number {
  const s = toMin(start), e = toMin(end);
  return e > s ? e - s : e + 1440 - s;
}

export function shiftMinutes(start: string, end: string, breakMinutes: number): number {
  return Math.max(0, spanMinutes(start, end) - breakMinutes);
}

/** Minutes of the shift falling in the 22:00–04:00 window (breaks ignored — conservative for the employee). */
export function nightMinutes(start: string, end: string): number {
  const s = toMin(start);
  const span = spanMinutes(start, end);
  let n = 0;
  for (let t = s; t < s + span; t++) {
    const m = t % 1440;
    if (m >= 22 * 60 || m < 4 * 60) n++;
  }
  return n;
}

export interface RotaStaff {
  id: number;
  name: string;
  restDay: number;        // 0 = Sunday … 6 = Saturday
  maxWeeklyHours: number;
  startDate: ISODate;
  endDate: ISODate | null;
}

export interface PlannedShift { date: ISODate; staffId: number; template: string; start: string; end: string; breakMinutes: number }
export interface RotaGap { date: ISODate; template: string; label: string; start: string; end: string }

/**
 * Fill every template on every day of the week starting `weekStart` (7 days).
 * Templates are filled in reverse order (closing first — evenings are busiest), each by the eligible person with
 * the fewest hours so far that week. Eligible = employed that day, not their rest day, not already on a shift that
 * day, and under their weekly cap after this shift. Anything left is a gap for the owners to cover.
 */
export function generateRota(weekStart: ISODate, staff: RotaStaff[], templates: ShiftTemplate[], existing: PlannedShift[] = []): { shifts: PlannedShift[]; gaps: RotaGap[] } {
  const hours = new Map<number, number>(staff.map((s) => [s.id, 0]));
  for (const e of existing) hours.set(e.staffId, (hours.get(e.staffId) ?? 0) + shiftMinutes(e.start, e.end, e.breakMinutes) / 60);
  const shifts: PlannedShift[] = [];
  const gaps: RotaGap[] = [];
  const order = [...templates].reverse();

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const busy = new Set(existing.filter((e) => e.date === date).map((e) => e.staffId));
    for (const t of order) {
      if (existing.some((e) => e.date === date && e.template === t.code)) continue;
      const h = shiftMinutes(t.start, t.end, t.break) / 60;
      const pick = staff
        .filter((s) => s.startDate <= date && (s.endDate === null || date <= s.endDate))
        .filter((s) => s.restDay !== dayOfWeek(date) && !busy.has(s.id))
        .filter((s) => (hours.get(s.id) ?? 0) + h <= s.maxWeeklyHours + 1e-9)
        .sort((a, b) => (hours.get(a.id) ?? 0) - (hours.get(b.id) ?? 0) || a.id - b.id)[0];
      if (!pick) {
        gaps.push({ date, template: t.code, label: t.label, start: t.start, end: t.end });
        continue;
      }
      busy.add(pick.id);
      hours.set(pick.id, (hours.get(pick.id) ?? 0) + h);
      shifts.push({ date, staffId: pick.id, template: t.code, start: t.start, end: t.end, breakMinutes: t.break });
    }
  }
  return { shifts, gaps };
}

export interface RotaWarning { staffId: number; date?: ISODate; message: string }

/** Compliance checks over a set of shifts covering one Monday–Sunday style 7-day window. */
export function rotaWarnings(shifts: PlannedShift[], staff: { id: number; name: string; maxWeeklyHours: number }[], maxDailyHours = 8): RotaWarning[] {
  const out: RotaWarning[] = [];
  for (const s of staff) {
    const mine = shifts.filter((x) => x.staffId === s.id);
    const byDay = new Map<string, number>();
    for (const x of mine) byDay.set(x.date, (byDay.get(x.date) ?? 0) + shiftMinutes(x.start, x.end, x.breakMinutes) / 60);
    for (const [date, h] of byDay) if (h > maxDailyHours + 1e-9) out.push({ staffId: s.id, date, message: `${s.name} is down for ${h.toFixed(1)} h on ${date} (over ${maxDailyHours} h — counts as overtime)` });
    const total = [...byDay.values()].reduce((a, b) => a + b, 0);
    if (total > s.maxWeeklyHours + 1e-9) out.push({ staffId: s.id, message: `${s.name} is down for ${total.toFixed(1)} h this week (cap ${s.maxWeeklyHours} h)` });
    if (byDay.size >= 7) out.push({ staffId: s.id, message: `${s.name} has no rest day this week` });
  }
  return out;
}
