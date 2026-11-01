import { describe, expect, it } from "vitest";
import { approveAndExecute, decideAction, getAction } from "../src/domain/approvals.js";
import { pnlRange } from "../src/domain/finance.js";
import { addPayrollAdjustment, addStaff, assignShift, freeStaff, generateWeekRota, getPayrollRun, markPayrollPaid, payrollPeriod, payrollRunIsStale, preparePayrollRun, shiftsBetween, updateShift, weekRota, weekStartOf } from "../src/domain/staff.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { freshDb } from "./helpers.js";

function withStaff() {
  const db = freshDb();
  const aisha = addStaff(db, { name: "Aisha", basicFils: 400_000, housingFils: 200_000, transportFils: 50_000, restDay: 5, startDate: "2026-10-08", iban: "AE07" });
  const rahul = addStaff(db, { name: "Rahul", basicFils: 350_000, housingFils: 200_000, transportFils: 50_000, otherFils: 50_000, restDay: 2, startDate: "2026-10-20" });
  for (const ws of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]) generateWeekRota(db, ws);
  db.prepare("DELETE FROM shifts WHERE date < '2026-10-08'").run();
  return { db, aisha, rahul };
}

describe("rota (database)", () => {
  it("weeks start on Monday", () => {
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26"); // Sunday → previous Monday
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02");
  });

  it("generates once; re-running fills only empty slots", () => {
    const { db } = withStaff();
    const before = shiftsBetween(db, "2026-11-02", "2026-11-08").length;
    expect(generateWeekRota(db, "2026-11-02").created).toBe(0);
    expect(shiftsBetween(db, "2026-11-02", "2026-11-08").length).toBe(before);
  });

  it("a sick shift becomes a gap, and only free people can cover it", () => {
    const { db, aisha } = withStaff();
    const s = shiftsBetween(db, "2026-11-02", "2026-11-02").find((x) => x.staffId === aisha)!;
    updateShift(db, s.id, { status: "sick" });
    expect(weekRota(db, "2026-11-02").gaps.some((g) => g.date === "2026-11-02" && g.template === s.template)).toBe(true);
    expect(freeStaff(db, "2026-11-02").map((x) => x.name)).toEqual([]); // Aisha is sick, Rahul is on the other shift
  });

  it("refuses a double shift unless forced", () => {
    const { db } = withStaff();
    const tue = shiftsBetween(db, "2026-11-03", "2026-11-03")[0]; // Rahul rests Tuesday → Aisha on one shift
    const other = tue.template === "open" ? "close" : "open";
    expect(() => assignShift(db, "2026-11-03", other, tue.staffId)).toThrow(/double shift/);
    assignShift(db, "2026-11-03", other, tue.staffId, { force: true });
    expect(weekRota(db, "2026-11-02").warnings.some((w) => /over 8 h/.test(w.message))).toBe(true);
  });
});

describe("payroll runs", () => {
  it("period: the 8th → 7th containing the date, paid on the 8th", () => {
    const { db } = withStaff();
    expect(payrollPeriod(db, "2026-11-06")).toEqual({ start: "2026-10-08", end: "2026-11-07", payDate: "2026-11-08" });
    expect(payrollPeriod(db, "2026-11-08").start).toBe("2026-11-08");
  });

  it("draft → approve → payment sheet → paid, with the approver recorded", async () => {
    const { db } = withStaff();
    const { run, created } = preparePayrollRun(db, "2026-11-06", "test");
    expect(created).toBe(true);
    expect(run.status).toBe("pending_approval");
    expect(run.lines.map((l) => l.name)).toEqual(["Aisha", "Rahul"]);
    const dir = "data/payroll-test";
    rmSync(dir, { recursive: true, force: true });
    const { executePayrollRun } = await import("../src/domain/staff.js");
    decideAction(db, run.actionId!, 3, "approve");
    const result = executePayrollRun(db, run.id, dir);
    expect(result).toMatch(/No IBAN on record for Rahul/);
    const sheet = readFileSync(`${dir}/LW-PAY-2026-11.csv`, "utf8");
    expect(sheet).toContain("Aisha,,AE07,31,4000.00,2500.00");
    expect(sheet.split("\n").at(-2)).toMatch(/^TOTAL/);
    expect(getPayrollRun(db, run.id)!.status).toBe("approved");
    markPayrollPaid(db, run.id);
    expect(getPayrollRun(db, run.id)!.status).toBe("paid");
    expect(() => markPayrollPaid(db, run.id)).toThrow();
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("the approval executor runs payroll through the normal approval flow", async () => {
    const { db } = withStaff();
    const { run } = preparePayrollRun(db, "2026-11-06", "test");
    const a = await approveAndExecute(db, run.actionId!, 1);
    expect(a.status).toBe("executed");
    expect(a.result).toMatch(/payment sheet/);
    rmSync("data/payroll/LW-PAY-2026-11.csv", { force: true });
  });

  it("rejecting cancels the run, and a new one can be drafted", () => {
    const { db } = withStaff();
    const { run } = preparePayrollRun(db, "2026-11-06", "test");
    decideAction(db, run.actionId!, 2, "reject", "wrong hours");
    expect(getPayrollRun(db, run.id)!.status).toBe("cancelled");
    expect(preparePayrollRun(db, "2026-11-06", "test").created).toBe(true);
  });

  it("a pending run is recalculated when shifts change, never duplicated", () => {
    const { db, rahul } = withStaff();
    const first = preparePayrollRun(db, "2026-11-06", "test").run;
    expect(preparePayrollRun(db, "2026-11-06", "test")).toMatchObject({ created: false, refreshed: false });
    const s = shiftsBetween(db, "2026-10-29", "2026-10-29").find((x) => x.staffId === rahul)!;
    updateShift(db, s.id, { status: "absent" });
    expect(payrollRunIsStale(db, getPayrollRun(db, first.id)!)).toBe(true);
    const again = preparePayrollRun(db, "2026-11-06", "test");
    expect(again).toMatchObject({ created: false, refreshed: true });
    expect(again.run.id).toBe(first.id);
    expect(again.run.netFils).toBe(first.netFils - Math.round(650_000 / 30));
    expect(getAction(db, first.actionId!)!.amountFils).toBe(again.run.netFils);
    expect((db.prepare("SELECT COUNT(*) n FROM payroll_runs").get() as any).n).toBe(1);
  });

  it("approved runs are never recalculated", async () => {
    const { db, aisha } = withStaff();
    const { run } = preparePayrollRun(db, "2026-11-06", "test");
    await approveAndExecute(db, run.actionId!, 1);
    addPayrollAdjustment(db, aisha, run.periodStart, 10_000, "late bonus");
    expect(preparePayrollRun(db, "2026-11-06", "test")).toMatchObject({ created: false, refreshed: false });
    expect(getPayrollRun(db, run.id)!.netFils).toBe(run.netFils);
    rmSync("data/payroll/LW-PAY-2026-11.csv", { force: true });
  });
});

describe("P&L with staff on record", () => {
  it("replaces the placeholder payroll cost with packages + gratuity accrual", () => {
    const db = freshDb();
    const before = pnlRange(db, "2026-11-01", "2026-11-01").totals.costsByCategory.payroll;
    expect(before).toBe(Math.round((1_400_000 * 25) / 31) - Math.round((1_400_000 * 24) / 31)); // placeholder AED 14,000/month
    addStaff(db, { name: "Aisha", basicFils: 400_000, housingFils: 200_000, transportFils: 50_000, startDate: "2026-10-08" });
    const share = (m: number) => Math.round((m * 25) / 31) - Math.round((m * 24) / 31);
    expect(pnlRange(db, "2026-11-01", "2026-11-01").totals.costsByCategory.payroll).toBe(share(650_000) + share(23_014));
  });

  it("books overtime / absence / bonuses as a one-off when payroll is approved", async () => {
    const { db, aisha } = withStaff();
    addPayrollAdjustment(db, aisha, "2026-10-08", 30_000, "bonus");
    const { run } = preparePayrollRun(db, "2026-11-06", "test");
    await approveAndExecute(db, run.actionId!, 1);
    const p = pnlRange(db, "2026-11-07", "2026-11-07");
    expect(p.days[0].oneOffCosts).toEqual([{ name: "LW-PAY-2026-11 overtime / absence / adjustments", category: "payroll", fils: 30_000 }]);
    rmSync("data/payroll/LW-PAY-2026-11.csv", { force: true });
  });
});
