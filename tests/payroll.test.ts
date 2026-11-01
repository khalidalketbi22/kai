import { describe, expect, it } from "vitest";
import { computePayroll, gratuityMonthlyAccrual, hourlyBasic, type PayrollStaff, type WorkedShift } from "../src/domain/payroll.js";

const rules = { maxDailyHours: 8, overtimePremium: 0.25, nightOvertimePremium: 0.5, dayDivisor: 30 };
const PERIOD = { start: "2026-10-08", end: "2026-11-07" }; // 31 days
const aisha: PayrollStaff = { id: 1, name: "Aisha", basicFils: 400_000, housingFils: 200_000, transportFils: 50_000, otherFils: 0, startDate: "2026-09-01", endDate: null };
const shift = (date: string, workedMinutes = 480, status: WorkedShift["status"] = "worked", nightMinutes = 0): WorkedShift => ({ staffId: 1, date, status, workedMinutes, nightMinutes });

describe("computePayroll", () => {
  it("a full month with no extras is exactly the package", () => {
    const [l] = computePayroll(PERIOD, [aisha], [shift("2026-10-10"), shift("2026-10-11")], [], rules);
    expect(l).toMatchObject({ daysEmployed: 31, basicFils: 400_000, allowancesFils: 250_000, overtimeFils: 0, absenceFils: 0, netFils: 650_000 });
  });

  it("hourly basic = basic × 12 / 365 / 8", () => expect(hourlyBasic(400_000)).toBeCloseTo(1643.84, 2));

  it("overtime beyond 8 h a day at +25% (worked example: 3 h → AED 61.64)", () => {
    // 11 h worked on one day → 3 h overtime × AED 16.4384 × 1.25 = AED 61.64
    const [l] = computePayroll(PERIOD, [aisha], [shift("2026-10-31", 11 * 60)], [], rules);
    expect(l.overtimeHours).toBe(3);
    expect(l.overtimeFils).toBe(6_164);
    expect(l.netFils).toBe(650_000 + 6_164);
  });

  it("two shifts on one day add up for overtime", () => {
    const [l] = computePayroll(PERIOD, [aisha], [shift("2026-10-20", 480), shift("2026-10-20", 240)], [], rules);
    expect(l.overtimeHours).toBe(4);
  });

  it("overtime worked at night (22:00–04:00) gets +50%", () => {
    // 10 h worked, 2 h of overtime, 1.5 h of the day falls at night → 1.5 h at +50%, 0.5 h at +25%
    const [l] = computePayroll(PERIOD, [aisha], [shift("2026-10-25", 600, "worked", 90)], [], rules);
    expect(l.overtimeFils).toBe(Math.round(1.5 * hourlyBasic(400_000) * 1.5 + 0.5 * hourlyBasic(400_000) * 1.25));
  });

  it("deducts unpaid absence at (basic + allowances) / 30 per day; sick and leave stay paid", () => {
    const [l] = computePayroll(PERIOD, [aisha], [shift("2026-10-12", 0, "absent"), shift("2026-10-13", 0, "sick"), shift("2026-10-14", 0, "leave")], [], rules);
    expect(l.absenceDays).toBe(1);
    expect(l.absenceFils).toBe(Math.round(650_000 / 30)); // AED 216.67
    expect(l.netFils).toBe(650_000 - 21_667);
    expect(l.notes.join(" ")).toMatch(/1 sick day/);
    expect(l.notes.join(" ")).toMatch(/1 annual leave day/);
  });

  it("prorates a joiner by days employed (joined 20 Oct → 19/31 days)", () => {
    const [l] = computePayroll(PERIOD, [{ ...aisha, startDate: "2026-10-20" }], [], [], rules);
    expect(l.daysEmployed).toBe(19);
    expect(l.basicFils).toBe(Math.round((400_000 * 19) / 31));
    expect(l.allowancesFils).toBe(Math.round((250_000 * 19) / 31));
    expect(l.notes[0]).toMatch(/joined 2026-10-20 — paid 19\/31 days/);
  });

  it("prorates a leaver and skips people outside the period", () => {
    const lines = computePayroll(PERIOD, [{ ...aisha, endDate: "2026-10-17" }, { ...aisha, id: 2, name: "Future", startDate: "2026-12-01" }], [], [], rules);
    expect(lines).toHaveLength(1);
    expect(lines[0].daysEmployed).toBe(10);
    expect(lines[0].notes[0]).toMatch(/left 2026-10-17/);
  });

  it("applies bonuses and deductions", () => {
    const [l] = computePayroll(PERIOD, [aisha], [], [{ staffId: 1, amountFils: 30_000, note: "Eid bonus" }, { staffId: 1, amountFils: -50_000, note: "advance recovery" }], rules);
    expect(l.adjustmentsFils).toBe(-20_000);
    expect(l.netFils).toBe(630_000);
    expect(l.notes).toEqual(["+AED 300.00 Eid bonus", "−AED 500.00 advance recovery"]);
  });

  it("ignores shifts outside the period", () => {
    const [l] = computePayroll(PERIOD, [aisha], [shift("2026-11-08", 12 * 60)], [], rules);
    expect(l.overtimeFils).toBe(0);
  });
});

describe("end-of-service gratuity accrual", () => {
  it("21 days' basic a year → AED 4,000 × 21 / 365 = AED 230.14 a month", () => expect(gratuityMonthlyAccrual(400_000)).toBe(23_014));
});
