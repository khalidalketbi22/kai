/**
 * Payroll for one business month (8th → 7th, paid on the 8th) — pure functions.
 *
 * Per person:
 *   basic + allowances, prorated by days employed in the period (joiners / leavers)
 * + overtime: hours worked beyond the daily limit (default 8) on any day, paid at the basic hourly wage
 *   (basic × 12 / 365 / 8) plus 25%, or plus 50% for overtime worked 22:00–04:00
 * − unpaid absence: (basic + allowances) / 30 per day marked absent
 * ± one-off adjustments (bonus, advance recovery, deduction)
 * = net pay
 *
 * Defaults follow common UAE practice; every rate is a setting. Confirm with your accountant or PRO before relying
 * on them, especially for sick leave and annual leave pay, which are recorded but not deducted here.
 */
import { daysBetweenInclusive, type ISODate } from "./periods.js";

export interface PayrollStaff {
  id: number;
  name: string;
  basicFils: number;
  housingFils: number;
  transportFils: number;
  otherFils: number;
  startDate: ISODate;
  endDate: ISODate | null;
}

export interface WorkedShift {
  staffId: number;
  date: ISODate;
  status: "worked" | "absent" | "sick" | "leave";
  workedMinutes: number;
  nightMinutes: number;
}

export interface PayrollAdjustment { staffId: number; amountFils: number; note: string }

export interface PayrollRules {
  maxDailyHours: number;
  overtimePremium: number;
  nightOvertimePremium: number;
  dayDivisor: number;
}

export interface PayrollLine {
  staffId: number;
  name: string;
  daysEmployed: number;
  basicFils: number;
  allowancesFils: number;
  overtimeHours: number;
  overtimeFils: number;
  absenceDays: number;
  absenceFils: number;
  adjustmentsFils: number;
  netFils: number;
  notes: string[];
}

export const hourlyBasic = (basicFils: number) => (basicFils * 12) / 365 / 8;

function overlapDays(a: ISODate, b: ISODate | null, start: ISODate, end: ISODate): number {
  const from = a > start ? a : start;
  const to = b !== null && b < end ? b : end;
  return from > to ? 0 : daysBetweenInclusive(from, to);
}

export function computePayroll(
  period: { start: ISODate; end: ISODate },
  staff: PayrollStaff[],
  shifts: WorkedShift[],
  adjustments: PayrollAdjustment[],
  rules: PayrollRules,
): PayrollLine[] {
  const periodDays = daysBetweenInclusive(period.start, period.end);
  const lines: PayrollLine[] = [];
  for (const s of staff) {
    const days = overlapDays(s.startDate, s.endDate, period.start, period.end);
    if (days === 0) continue;
    const notes: string[] = [];
    const factor = days / periodDays;
    const allowancesMonthly = s.housingFils + s.transportFils + s.otherFils;
    const basic = Math.round(s.basicFils * factor);
    const allowances = Math.round(allowancesMonthly * factor);
    if (days < periodDays) {
      notes.push(`${s.startDate > period.start ? `joined ${s.startDate}` : ""}${s.startDate > period.start && s.endDate ? ", " : ""}${s.endDate && s.endDate < period.end ? `left ${s.endDate}` : ""} — paid ${days}/${periodDays} days`);
    }

    // Overtime, per day
    const mine = shifts.filter((x) => x.staffId === s.id && x.date >= period.start && x.date <= period.end);
    const perDay = new Map<string, { worked: number; night: number }>();
    for (const x of mine.filter((m) => m.status === "worked")) {
      const d = perDay.get(x.date) ?? { worked: 0, night: 0 };
      d.worked += x.workedMinutes;
      d.night += x.nightMinutes;
      perDay.set(x.date, d);
    }
    let otDayMin = 0, otNightMin = 0;
    for (const d of perDay.values()) {
      const ot = Math.max(0, d.worked - rules.maxDailyHours * 60);
      const night = Math.min(ot, d.night);
      otNightMin += night;
      otDayMin += ot - night;
    }
    const hourly = hourlyBasic(s.basicFils);
    const overtimeFils = Math.round((otDayMin / 60) * hourly * (1 + rules.overtimePremium) + (otNightMin / 60) * hourly * (1 + rules.nightOvertimePremium));
    const overtimeHours = Math.round(((otDayMin + otNightMin) / 60) * 100) / 100;
    if (overtimeHours > 0) notes.push(`overtime ${overtimeHours} h${otNightMin ? ` (${(otNightMin / 60).toFixed(1)} h at night rate)` : ""}`);

    // Unpaid absence
    const absenceDays = new Set(mine.filter((m) => m.status === "absent").map((m) => m.date)).size;
    const absenceFils = Math.round((absenceDays * (s.basicFils + allowancesMonthly)) / rules.dayDivisor);
    if (absenceDays) notes.push(`${absenceDays} unpaid absence day${absenceDays > 1 ? "s" : ""}`);
    const sick = new Set(mine.filter((m) => m.status === "sick").map((m) => m.date)).size;
    const leave = new Set(mine.filter((m) => m.status === "leave").map((m) => m.date)).size;
    if (sick) notes.push(`${sick} sick day${sick > 1 ? "s" : ""} (paid — check sick-leave entitlement)`);
    if (leave) notes.push(`${leave} annual leave day${leave > 1 ? "s" : ""} (paid)`);

    const adj = adjustments.filter((a) => a.staffId === s.id);
    const adjustmentsFils = adj.reduce((t, a) => t + a.amountFils, 0);
    for (const a of adj) notes.push(`${a.amountFils >= 0 ? "+" : "−"}AED ${(Math.abs(a.amountFils) / 100).toFixed(2)} ${a.note}`);

    lines.push({
      staffId: s.id,
      name: s.name,
      daysEmployed: days,
      basicFils: basic,
      allowancesFils: allowances,
      overtimeHours,
      overtimeFils,
      absenceDays,
      absenceFils,
      adjustmentsFils,
      netFils: basic + allowances + overtimeFils - absenceFils + adjustmentsFils,
      notes,
    });
  }
  return lines;
}

/** Monthly end-of-service gratuity accrual: `days` of basic wage per year of service → basic × days / 365 a month. */
export const gratuityMonthlyAccrual = (basicFils: number, daysPerYear = 21) => Math.round((basicFils * daysPerYear) / 365);
