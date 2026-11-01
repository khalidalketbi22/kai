/**
 * Staff service: people, the weekly rota, hours worked and payroll runs (database side).
 * The maths lives in rota.ts and payroll.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db/index.js";
import { getNumberSetting, getSetting } from "../db/index.js";
import { toCsv } from "../importers/csv.js";
import { addDays, businessMonth, dayOfWeek, todayInDubai, type ISODate } from "./periods.js";
import { computePayroll, type PayrollLine, type WorkedShift } from "./payroll.js";
import { generateRota, nightMinutes, rotaWarnings, shiftMinutes, type PlannedShift, type RotaGap, type RotaWarning, type ShiftTemplate } from "./rota.js";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface StaffRow {
  id: number;
  name: string;
  role: string;
  phone: string | null;
  email: string | null;
  basicFils: number;
  housingFils: number;
  transportFils: number;
  otherFils: number;
  restDay: number;
  maxWeeklyHours: number;
  startDate: ISODate;
  endDate: ISODate | null;
  iban: string | null;
  personalId: string | null;
}

const toStaff = (r: any): StaffRow => ({
  id: r.id, name: r.name, role: r.role, phone: r.phone, email: r.email, basicFils: r.basic_fils, housingFils: r.housing_fils,
  transportFils: r.transport_fils, otherFils: r.other_fils, restDay: r.rest_day, maxWeeklyHours: r.max_weekly_hours,
  startDate: r.start_date, endDate: r.end_date, iban: r.iban, personalId: r.personal_id,
});

export function listStaff(db: DB, activeOn?: ISODate): StaffRow[] {
  const rows = (db.prepare("SELECT * FROM staff ORDER BY id").all() as any[]).map(toStaff);
  return activeOn ? rows.filter((s) => s.startDate <= activeOn && (s.endDate === null || activeOn <= s.endDate)) : rows;
}

export function staffByName(db: DB, name: string): StaffRow {
  const r = db.prepare("SELECT * FROM staff WHERE lower(name) = lower(?)").get(name);
  if (!r) throw new Error(`No staff member named "${name}". Run: npm run liwan -- staff`);
  return toStaff(r);
}

export interface StaffInput {
  name: string; role?: string; phone?: string | null; email?: string | null;
  basicFils: number; housingFils?: number; transportFils?: number; otherFils?: number;
  restDay?: number; maxWeeklyHours?: number; startDate: ISODate; endDate?: ISODate | null; iban?: string | null; personalId?: string | null;
}

export function addStaff(db: DB, s: StaffInput): number {
  const r = db
    .prepare(
      `INSERT INTO staff (name, role, phone, email, basic_fils, housing_fils, transport_fils, other_fils, rest_day, max_weekly_hours, start_date, end_date, iban, personal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.name, s.role ?? "barista", s.phone ?? null, s.email ?? null, s.basicFils, s.housingFils ?? 0, s.transportFils ?? 0, s.otherFils ?? 0,
      s.restDay ?? 5, s.maxWeeklyHours ?? 48, s.startDate, s.endDate ?? null, s.iban ?? null, s.personalId ?? null);
  return Number(r.lastInsertRowid);
}

const COLS: Record<string, string> = {
  role: "role", phone: "phone", email: "email", basicFils: "basic_fils", housingFils: "housing_fils", transportFils: "transport_fils",
  otherFils: "other_fils", restDay: "rest_day", maxWeeklyHours: "max_weekly_hours", startDate: "start_date", endDate: "end_date",
  iban: "iban", personalId: "personal_id", name: "name",
};

export function updateStaff(db: DB, id: number, patch: Partial<StaffInput>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !COLS[k]) continue;
    db.prepare(`UPDATE staff SET ${COLS[k]} = ? WHERE id = ?`).run(v, id);
  }
}

export function shiftTemplates(db: DB): ShiftTemplate[] {
  return JSON.parse(getSetting(db, "shift_templates"));
}

/** Monday of the week containing `d` (the rota runs Monday → Sunday). */
export function weekStartOf(d: ISODate): ISODate {
  const dow = dayOfWeek(d);
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}

export interface ShiftRow {
  id: number; staffId: number; staffName: string; date: ISODate; template: string; start: string; end: string; breakMinutes: number;
  status: "planned" | "worked" | "absent" | "sick" | "leave"; actualStart: string | null; actualEnd: string | null; note: string | null; hours: number;
}

export function shiftsBetween(db: DB, from: ISODate, to: ISODate): ShiftRow[] {
  return (
    db
      .prepare(`SELECT sh.*, st.name AS staff_name FROM shifts sh JOIN staff st ON st.id = sh.staff_id WHERE sh.date BETWEEN ? AND ? ORDER BY sh.date, sh.start_time, st.name`)
      .all(from, to) as any[]
  ).map((r) => ({
    id: r.id, staffId: r.staff_id, staffName: r.staff_name, date: r.date, template: r.template, start: r.start_time, end: r.end_time,
    breakMinutes: r.break_minutes, status: r.status, actualStart: r.actual_start, actualEnd: r.actual_end, note: r.note,
    hours: shiftMinutes(r.actual_start ?? r.start_time, r.actual_end ?? r.end_time, r.break_minutes) / 60,
  }));
}

const asPlanned = (s: ShiftRow): PlannedShift => ({ date: s.date, staffId: s.staffId, template: s.template, start: s.actualStart ?? s.start, end: s.actualEnd ?? s.end, breakMinutes: s.breakMinutes });

export interface WeekRota { weekStart: ISODate; weekEnd: ISODate; shifts: ShiftRow[]; gaps: RotaGap[]; warnings: RotaWarning[]; templates: ShiftTemplate[] }

export function weekRota(db: DB, weekStart: ISODate): WeekRota {
  const weekEnd = addDays(weekStart, 6);
  const templates = shiftTemplates(db);
  const shifts = shiftsBetween(db, weekStart, weekEnd);
  const gaps: RotaGap[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    for (const t of templates) {
      const covered = shifts.some((s) => s.date === date && s.template === t.code && s.status !== "absent" && s.status !== "sick" && s.status !== "leave");
      if (!covered) gaps.push({ date, template: t.code, label: t.label, start: t.start, end: t.end });
    }
  }
  const staff = listStaff(db);
  const warnings = rotaWarnings(shifts.filter((s) => s.status !== "absent" && s.status !== "sick" && s.status !== "leave").map(asPlanned), staff, getNumberSetting(db, "max_daily_hours"));
  return { weekStart, weekEnd, shifts, gaps, warnings, templates };
}

/** Fill the empty slots of a week with planned shifts. Existing shifts are kept. */
export function generateWeekRota(db: DB, weekStart: ISODate): WeekRota & { created: number } {
  const existing = shiftsBetween(db, weekStart, addDays(weekStart, 6)).map(asPlanned);
  const staff = listStaff(db).map((s) => ({ id: s.id, name: s.name, restDay: s.restDay, maxWeeklyHours: s.maxWeeklyHours, startDate: s.startDate, endDate: s.endDate }));
  const { shifts } = generateRota(weekStart, staff, shiftTemplates(db), existing);
  const ins = db.prepare("INSERT OR IGNORE INTO shifts (staff_id, date, template, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?, ?, ?)");
  let created = 0;
  db.transaction(() => { for (const s of shifts) created += ins.run(s.staffId, s.date, s.template, s.start, s.end, s.breakMinutes).changes; })();
  return { ...weekRota(db, weekStart), created };
}

export function updateShift(db: DB, id: number, patch: { status?: ShiftRow["status"]; actualStart?: string | null; actualEnd?: string | null; note?: string | null; staffId?: number }): void {
  const row = db.prepare("SELECT id FROM shifts WHERE id = ?").get(id);
  if (!row) throw new Error(`No shift #${id}`);
  if (patch.actualStart) shiftMinutes(patch.actualStart, patch.actualEnd ?? patch.actualStart, 0); // validates the format
  const map: Record<string, string> = { status: "status", actualStart: "actual_start", actualEnd: "actual_end", note: "note", staffId: "staff_id" };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) db.prepare(`UPDATE shifts SET ${map[k]} = ? WHERE id = ?`).run(v, id);
}

/** People free for a shift on `date`: employed, not on their rest day, not already on another shift that day. */
export function freeStaff(db: DB, date: ISODate): StaffRow[] {
  // Anyone with a shift row that day is unavailable: already working, or off sick / absent / on leave.
  const busy = new Set((db.prepare("SELECT staff_id FROM shifts WHERE date = ?").all(date) as any[]).map((r) => r.staff_id));
  return listStaff(db, date).filter((s) => s.restDay !== dayOfWeek(date) && !busy.has(s.id));
}

/** Put someone on a slot (fills a gap or swaps the person). Refuses a double shift unless forced. */
export function assignShift(db: DB, date: ISODate, templateCode: string, staffId: number, opts: { force?: boolean } = {}): number {
  const t = shiftTemplates(db).find((x) => x.code === templateCode);
  if (!t) throw new Error(`No shift template "${templateCode}" (have: ${shiftTemplates(db).map((x) => x.code).join(", ")})`);
  const clash = db
    .prepare("SELECT sh.template, st.name FROM shifts sh JOIN staff st ON st.id = sh.staff_id WHERE sh.staff_id = ? AND sh.date = ? AND sh.template <> ? AND sh.status IN ('planned','worked')")
    .get(staffId, date, templateCode) as any;
  if (clash && !opts.force) {
    throw new Error(`${clash.name} is already on the ${clash.template} shift on ${date} — that would be a double shift with overtime. Use --force in the terminal if that's really the plan.`);
  }
  const existing = db.prepare("SELECT id FROM shifts WHERE date = ? AND template = ? AND status IN ('planned','worked')").get(date, templateCode) as any;
  if (existing) {
    db.prepare("UPDATE shifts SET staff_id = ? WHERE id = ?").run(staffId, existing.id);
    return existing.id;
  }
  return Number(db.prepare("INSERT INTO shifts (staff_id, date, template, start_time, end_time, break_minutes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(staff_id, date, template) DO UPDATE SET status = 'planned'").run(staffId, date, t.code, t.start, t.end, t.break).lastInsertRowid);
}

/** Shifts as payroll sees them: planned shifts count as worked (past) or as rostered (future). */
export function workedShifts(db: DB, from: ISODate, to: ISODate): WorkedShift[] {
  return shiftsBetween(db, from, to).map((s) => {
    const start = s.actualStart ?? s.start, end = s.actualEnd ?? s.end;
    return {
      staffId: s.staffId,
      date: s.date,
      status: s.status === "planned" ? "worked" : s.status,
      workedMinutes: shiftMinutes(start, end, s.breakMinutes),
      nightMinutes: nightMinutes(start, end),
    };
  });
}

export interface HoursRow { staffId: number; name: string; shifts: number; hours: number; overtimeHours: number; absent: number; sick: number; leave: number }

export function hoursSummary(db: DB, from: ISODate, to: ISODate): HoursRow[] {
  const maxDaily = getNumberSetting(db, "max_daily_hours") * 60;
  const ws = workedShifts(db, from, to);
  return listStaff(db).map((s) => {
    const mine = ws.filter((w) => w.staffId === s.id);
    const worked = mine.filter((w) => w.status === "worked");
    const perDay = new Map<string, number>();
    for (const w of worked) perDay.set(w.date, (perDay.get(w.date) ?? 0) + w.workedMinutes);
    const ot = [...perDay.values()].reduce((t, m) => t + Math.max(0, m - maxDaily), 0);
    return {
      staffId: s.id, name: s.name, shifts: worked.length,
      hours: Math.round((worked.reduce((t, w) => t + w.workedMinutes, 0) / 60) * 10) / 10,
      overtimeHours: Math.round((ot / 60) * 10) / 10,
      absent: mine.filter((w) => w.status === "absent").length,
      sick: mine.filter((w) => w.status === "sick").length,
      leave: mine.filter((w) => w.status === "leave").length,
    };
  }).filter((r) => r.shifts + r.absent + r.sick + r.leave > 0 || listStaff(db, to).some((s) => s.id === r.staffId));
}

// ------------------------------------------------------------------ payroll runs

export const payrollNumber = (periodEnd: ISODate) => `LW-PAY-${periodEnd.slice(0, 7)}`;

/** The payroll period that is paid next: the business month containing `date` (8th → 7th), paid on the 8th after. */
export function payrollPeriod(db: DB, date: ISODate): { start: ISODate; end: ISODate; payDate: ISODate } {
  const m = businessMonth(date, getNumberSetting(db, "business_month_start_day"));
  return { start: m.start, end: m.end, payDate: addDays(m.end, 1) };
}

export function previewPayroll(db: DB, period: { start: ISODate; end: ISODate }): PayrollLine[] {
  const staff = listStaff(db);
  const adjustments = (db.prepare("SELECT staff_id, amount_fils, note FROM payroll_adjustments WHERE period_start = ?").all(period.start) as any[]).map((a) => ({ staffId: a.staff_id, amountFils: a.amount_fils, note: a.note }));
  return computePayroll(period, staff, workedShifts(db, period.start, period.end), adjustments, {
    maxDailyHours: getNumberSetting(db, "max_daily_hours"),
    overtimePremium: getNumberSetting(db, "overtime_premium"),
    nightOvertimePremium: getNumberSetting(db, "night_overtime_premium"),
    dayDivisor: getNumberSetting(db, "payroll_day_divisor"),
  });
}

export function addPayrollAdjustment(db: DB, staffId: number, periodStart: ISODate, amountFils: number, note: string): void {
  if (!note.trim()) throw new Error("An adjustment needs a note (e.g. 'Eid bonus' or 'advance recovery')");
  db.prepare("INSERT INTO payroll_adjustments (staff_id, period_start, amount_fils, note) VALUES (?, ?, ?, ?)").run(staffId, periodStart, amountFils, note.trim());
}

export interface PayrollRunView {
  id: number; number: string; periodStart: ISODate; periodEnd: ISODate; payDate: ISODate; status: string;
  grossFils: number; netFils: number; createdAt: string; createdBy: string; actionId: number | null; sheetPath: string | null; paidAt: string | null;
  lines: (PayrollLine & { iban: string | null; personalId: string | null })[];
}

export function getPayrollRun(db: DB, id: number): PayrollRunView | null {
  const r = db.prepare("SELECT * FROM payroll_runs WHERE id = ?").get(id) as any;
  if (!r) return null;
  const lines = (db.prepare("SELECT l.*, s.name, s.iban, s.personal_id FROM payroll_lines l JOIN staff s ON s.id = l.staff_id WHERE l.run_id = ? ORDER BY l.id").all(id) as any[]).map((l) => ({
    staffId: l.staff_id, name: l.name, daysEmployed: l.days_employed, basicFils: l.basic_fils, allowancesFils: l.allowances_fils,
    overtimeHours: l.overtime_hours, overtimeFils: l.overtime_fils, absenceDays: l.absence_days, absenceFils: l.absence_fils,
    adjustmentsFils: l.adjustments_fils, netFils: l.net_fils, notes: l.notes ? JSON.parse(l.notes) : [], iban: l.iban, personalId: l.personal_id,
  }));
  return {
    id: r.id, number: payrollNumber(r.period_end), periodStart: r.period_start, periodEnd: r.period_end, payDate: r.pay_date, status: r.status,
    grossFils: r.gross_fils, netFils: r.net_fils, createdAt: r.created_at, createdBy: r.created_by, actionId: r.action_id, sheetPath: r.sheet_path, paidAt: r.paid_at, lines,
  };
}

export function listPayrollRuns(db: DB, limit = 12): PayrollRunView[] {
  return (db.prepare("SELECT id FROM payroll_runs ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => getPayrollRun(db, r.id)!);
}

const sameLines = (a: PayrollLine[], b: PayrollRunView["lines"]) =>
  a.length === b.length && a.every((l, i) => l.staffId === b[i].staffId && l.netFils === b[i].netFils && JSON.stringify(l.notes) === JSON.stringify(b[i].notes));

/** True when shifts or adjustments changed after a still-pending run was drafted. */
export function payrollRunIsStale(db: DB, run: PayrollRunView): boolean {
  return run.status === "pending_approval" && !sameLines(previewPayroll(db, { start: run.periodStart, end: run.periodEnd }), run.lines);
}

/**
 * Draft the payroll for the period containing `date` and ask the owners to approve it.
 * - No run yet for the period → create one (pending approval).
 * - A run is still pending → recalculate it in place if shifts/adjustments changed, so owners never approve stale numbers.
 * - Already approved or paid → returned unchanged.
 */
export function preparePayrollRun(db: DB, date: ISODate, by: string, now = new Date().toISOString()): { run: PayrollRunView; created: boolean; refreshed: boolean } {
  const p = payrollPeriod(db, date);
  const open = db.prepare("SELECT id, status FROM payroll_runs WHERE period_start = ? AND status IN ('pending_approval','approved','paid')").get(p.start) as any;
  if (open && open.status !== "pending_approval") return { run: getPayrollRun(db, open.id)!, created: false, refreshed: false };
  const lines = previewPayroll(db, p);
  if (!lines.length) throw new Error("No staff employed in this period — add staff first: npm run liwan -- staff add …");
  if (open) {
    const current = getPayrollRun(db, open.id)!;
    if (sameLines(lines, current.lines)) return { run: current, created: false, refreshed: false };
  }
  const gross = lines.reduce((t, l) => t + l.basicFils + l.allowancesFils + l.overtimeFils + Math.max(0, l.adjustmentsFils), 0);
  const net = lines.reduce((t, l) => t + l.netFils, 0);
  const future = todayInDubai() <= p.end ? ` Shifts from ${todayInDubai() > p.start ? todayInDubai() : p.start} to ${p.end} are counted as rostered.` : "";
  const summary = `${payrollNumber(p.end)} · Payroll ${p.start} → ${p.end}: ${lines.length} staff, AED ${(net / 100).toFixed(2)} net, pay on ${p.payDate}.${future}`;
  let runId = open?.id ?? 0;
  db.transaction(() => {
    if (open) {
      db.prepare("DELETE FROM payroll_lines WHERE run_id = ?").run(runId);
      db.prepare("UPDATE payroll_runs SET gross_fils = ?, net_fils = ? WHERE id = ?").run(gross, net, runId);
      db.prepare("UPDATE actions SET summary = ?, amount_fils = ? WHERE id = (SELECT action_id FROM payroll_runs WHERE id = ?) AND status = 'pending_approval'").run(`${summary} (recalculated ${now.slice(0, 16).replace("T", " ")})`, net, runId);
    } else {
      runId = Number(db.prepare("INSERT INTO payroll_runs (period_start, period_end, pay_date, status, gross_fils, net_fils, created_at, created_by) VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?)").run(p.start, p.end, p.payDate, gross, net, now, by).lastInsertRowid);
    }
    const ins = db.prepare(
      `INSERT INTO payroll_lines (run_id, staff_id, days_employed, basic_fils, allowances_fils, overtime_hours, overtime_fils, absence_days, absence_fils, adjustments_fils, net_fils, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) ins.run(runId, l.staffId, l.daysEmployed, l.basicFils, l.allowancesFils, l.overtimeHours, l.overtimeFils, l.absenceDays, l.absenceFils, l.adjustmentsFils, l.netFils, JSON.stringify(l.notes));
    if (!open) {
      const actionId = Number(
        db.prepare("INSERT INTO actions (type, payload, summary, amount_fils, status, proposed_by, proposed_at) VALUES ('payroll_run', ?, ?, ?, 'pending_approval', ?, ?)").run(JSON.stringify({ runId }), summary, net, by, now).lastInsertRowid,
      );
      db.prepare("UPDATE payroll_runs SET action_id = ? WHERE id = ?").run(actionId, runId);
    }
  })();
  return { run: getPayrollRun(db, runId)!, created: !open, refreshed: Boolean(open) };
}

/** Executor for an approved payroll run: writes the bank / WPS payment sheet and books variable pay into the P&L. */
export function executePayrollRun(db: DB, runId: number, dir = "data/payroll"): string {
  const run = getPayrollRun(db, runId);
  if (!run) throw new Error(`Payroll run ${runId} not found`);
  const missing = run.lines.filter((l) => !l.iban).map((l) => l.name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run.number}.csv`);
  const a = (f: number) => (f / 100).toFixed(2);
  writeFileSync(
    path,
    toCsv([
      ["Employee", "Personal ID", "IBAN", "Days", "Basic", "Allowances", "Overtime", "Absence deduction", "Adjustments", "Net pay", "Pay date", "Notes"],
      ...run.lines.map((l) => [l.name, l.personalId ?? "", l.iban ?? "", l.daysEmployed, a(l.basicFils), a(l.allowancesFils), a(l.overtimeFils), a(l.absenceFils), a(l.adjustmentsFils), a(l.netFils), run.payDate, l.notes.join("; ")]),
      ["TOTAL", "", "", "", a(run.lines.reduce((t, l) => t + l.basicFils, 0)), a(run.lines.reduce((t, l) => t + l.allowancesFils, 0)), a(run.lines.reduce((t, l) => t + l.overtimeFils, 0)), a(run.lines.reduce((t, l) => t + l.absenceFils, 0)), a(run.lines.reduce((t, l) => t + l.adjustmentsFils, 0)), a(run.netFils), "", ""],
    ]),
  );
  // The P&L already carries each person's monthly package; book the difference (overtime, absence, adjustments).
  const variable = run.lines.reduce((t, l) => t + l.overtimeFils - l.absenceFils + l.adjustmentsFils, 0);
  if (variable !== 0) {
    db.prepare("INSERT INTO expenses (name, category, kind, amount_fils, start_date) VALUES (?, 'payroll', 'one_off', ?, ?)").run(`${run.number} overtime / absence / adjustments`, variable, run.periodEnd);
  }
  db.prepare("UPDATE payroll_runs SET status = 'approved', sheet_path = ? WHERE id = ?").run(path, runId);
  return `${run.number} approved — payment sheet ${path}. Pay AED ${(run.netFils / 100).toFixed(2)} by ${run.payDate} through your bank / WPS agent, then mark it paid.${missing.length ? ` ⚠ No IBAN on record for ${missing.join(", ")}.` : ""}`;
}

export function markPayrollPaid(db: DB, runId: number, now = new Date().toISOString()): void {
  const r = db.prepare("UPDATE payroll_runs SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'approved'").run(now, runId);
  if (r.changes === 0) throw new Error("Only an approved payroll run can be marked paid.");
}

export const restDayName = (d: number) => DAY_NAMES[d];
export const parseRestDay = (v: string): number => {
  const i = DAY_NAMES.findIndex((n) => n.toLowerCase().startsWith(v.toLowerCase().slice(0, 3)));
  if (i < 0 && !/^[0-6]$/.test(v)) throw new Error(`Rest day must be a weekday name (e.g. Friday), got "${v}"`);
  return i >= 0 ? i : Number(v);
};
export { type ShiftTemplate };
