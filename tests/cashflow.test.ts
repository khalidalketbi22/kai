import { describe, expect, it } from "vitest";
import { forecastCash, vatQuarter, type ForecastInput } from "../src/domain/cashflow.js";

describe("VAT quarters", () => {
  it("calendar quarters, return due 28 days after", () => {
    expect(vatQuarter("2026-11-01")).toEqual({ start: "2026-10-01", end: "2026-12-31", due: "2027-01-28" });
    expect(vatQuarter("2027-03-31")).toEqual({ start: "2027-01-01", end: "2027-03-31", due: "2027-04-28" });
  });
  it("tax periods starting in another month (FTA-assigned stagger)", () => {
    expect(vatQuarter("2026-11-15", 2)).toEqual({ start: "2026-11-01", end: "2027-01-31", due: "2027-02-28" });
    expect(vatQuarter("2027-01-10", 2)).toEqual({ start: "2026-11-01", end: "2027-01-31", due: "2027-02-28" });
    expect(vatQuarter("2026-10-31", 2).start).toBe("2026-08-01");
  });
});

const base: ForecastInput = {
  start: "2026-11-02", weeks: 2, openingFils: 1_000_000,
  dailyTakingsInclVatFils: 315_000, dailyNetExVatFils: 300_000, dailyPurchasesExVatFils: 60_000,
  vatRate: 0.05, rentPct: 0.15, rentStartDate: "2026-11-01",
  fixed: [
    { name: "Salaries", category: "payroll", monthlyFils: 1_400_000, startDate: "2026-10-08", endDate: null },
    { name: "Machine lease", category: "lease", monthlyFils: 250_000, startDate: "2026-10-08", endDate: "2026-12-31" },
  ],
  businessMonthStartDay: 8, vatPayments: [],
};

describe("cash-flow forecast", () => {
  it("worked example: week 1 pays salaries + lease on the 8th", () => {
    const [w1, w2] = forecastCash(base);
    // 7 days: takings 2,205,000; restock 7 × 60,000 × 1.05 = 441,000; rent 7 × 45,000 = 315,000; monthly costs 1,650,000 on 8 Nov
    expect(w1).toMatchObject({ weekStart: "2026-11-02", weekEnd: "2026-11-08", takingsFils: 2_205_000, purchasesFils: 441_000, rentFils: 315_000, fixedCostsFils: 1_650_000 });
    expect(w1.netFils).toBe(2_205_000 - 441_000 - 315_000 - 1_650_000);
    expect(w1.closingFils).toBe(1_000_000 + w1.netFils);
    expect(w1.events[0]).toMatch(/2026-11-08: monthly costs/);
    expect(w2.fixedCostsFils).toBe(0);
    expect(w2.closingFils).toBe(w1.closingFils + w2.netFils);
  });

  it("drops the machine lease after December", () => {
    const weeks = forecastCash({ ...base, start: "2027-01-04", weeks: 1 });
    expect(weeks[0].fixedCostsFils).toBe(1_400_000);
  });

  it("charges no rent before the rent start date", () => {
    const [w] = forecastCash({ ...base, start: "2026-10-26", weeks: 1 });
    expect(w.rentFils).toBe(45_000); // only 1 Nov
  });

  it("pays VAT in the week it is due", () => {
    const weeks = forecastCash({ ...base, start: "2027-01-25", weeks: 2, vatPayments: [{ date: "2027-01-28", amountFils: 560_000 }] });
    expect(weeks[0].vatPaidFils).toBe(560_000);
    expect(weeks[1].vatPaidFils).toBe(0);
  });
});
