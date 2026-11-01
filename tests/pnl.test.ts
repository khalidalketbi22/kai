import { describe, expect, it } from "vitest";
import { parseAedToFils, splitVatInclusive, formatAed } from "../src/domain/money.js";
import { addMonths, businessMonth, eachDay } from "../src/domain/periods.js";
import { computeDailyPnl, dailyShareOfMonthly, rentForDay, sumPnl, type DaySales, type FixedCost, type PnlConfig } from "../src/domain/pnl.js";
import { computePayback } from "../src/domain/payback.js";

const cfg: PnlConfig = { rentPct: 0.15, rentStartDate: "2026-11-01", businessMonthStartDay: 8 };
const day = (date: string, over: Partial<DaySales> = {}): DaySales => ({
  date, orders: 80, grossFils: 0, discountFils: 0, vatFils: 0, netExVatFils: 300_000, cogsFils: 60_000, wasteFils: 5_000, ...over,
});
const payroll: FixedCost = { name: "Salaries", category: "payroll", monthlyFils: 1_400_000, startDate: "2026-10-08", endDate: null };
const lease: FixedCost = { name: "Machine lease", category: "lease", monthlyFils: 250_000, startDate: "2026-10-08", endDate: "2026-12-31" };

describe("VAT (5%, prices VAT-inclusive)", () => {
  it("AED 24.00 latte → VAT 1.14, net 22.86", () => expect(splitVatInclusive(2400)).toEqual({ vatFils: 114, netExVatFils: 2286 }));
  it("AED 26.00 → VAT 1.24 (rounded half-up)", () => expect(splitVatInclusive(2600).vatFils).toBe(124));
  it("AED 105.00 → exactly AED 5.00 VAT", () => expect(splitVatInclusive(10_500)).toEqual({ vatFils: 500, netExVatFils: 10_000 }));
  it("VAT + net always equals the inclusive amount", () => {
    for (const incl of [1, 99, 1234, 3850, 99_999]) {
      const s = splitVatInclusive(incl);
      expect(s.vatFils + s.netExVatFils).toBe(incl);
    }
  });
});

describe("money parsing", () => {
  it("parses POS money strings", () => {
    expect(parseAedToFils("24.00")).toBe(2400);
    expect(parseAedToFils("1,250.50")).toBe(125_050);
    expect(parseAedToFils("AED 26")).toBe(2600);
    expect(parseAedToFils("")).toBe(0);
    expect(parseAedToFils("0.1")).toBe(10);
  });
  it("formats AED", () => expect(formatAed(125_050)).toBe("AED 1,250.50"));
});

describe("business month (8th → 7th)", () => {
  it("1 Nov 2026 falls in 8 Oct – 7 Nov (31 days)", () => expect(businessMonth("2026-11-01")).toEqual({ start: "2026-10-08", end: "2026-11-07", days: 31 }));
  it("the 7th is the last day; the 8th starts a new month", () => {
    expect(businessMonth("2026-11-07").start).toBe("2026-10-08");
    expect(businessMonth("2026-11-08")).toEqual({ start: "2026-11-08", end: "2026-12-07", days: 30 });
  });
  it("wraps the year", () => expect(businessMonth("2027-01-05")).toEqual({ start: "2026-12-08", end: "2027-01-07", days: 31 }));
  it("February business month (8 Feb – 7 Mar 2027) has 28 days", () => expect(businessMonth("2027-02-20").days).toBe(28));
});

describe("pro-rating fixed costs", () => {
  it("daily shares add up to exactly the monthly amount (31- and 30-day business months)", () => {
    for (const start of ["2026-10-08", "2026-11-08", "2027-02-08"]) {
      const m = businessMonth(start);
      const total = eachDay(m.start, m.end).reduce((s, d) => s + dailyShareOfMonthly(1_400_000, d, 8), 0);
      expect(total).toBe(1_400_000);
    }
  });
  it("AED 14,000 over 31 days ≈ AED 451.61 a day", () => expect(dailyShareOfMonthly(1_400_000, "2026-11-01", 8)).toBe(45_161));
});

describe("rent at 15% of net sales from 1 Nov 2026", () => {
  it("no rent before 1 Nov", () => expect(rentForDay(300_000, "2026-10-31", cfg)).toBe(0));
  it("15% from 1 Nov", () => expect(rentForDay(300_000, "2026-11-01", cfg)).toBe(45_000));
  it("rounds to the fils", () => expect(rentForDay(258_873, "2026-11-02", cfg)).toBe(38_831));
});

describe("computeDailyPnl", () => {
  it("worked example for 1 Nov 2026", () => {
    // Net 3,000.00; COGS 600.00; waste 50.00 → gross profit 2,350.00
    // Rent 15% = 450.00; salaries 14,000/31 → 451.61; lease 2,500/31 → 80.65
    // Operating profit = 2,350.00 − 450.00 − 451.61 − 80.65 = 1,367.74
    const p = computeDailyPnl(day("2026-11-01"), [payroll, lease], [], cfg);
    expect(p.grossProfitFils).toBe(235_000);
    expect(p.grossMarginPct).toBeCloseTo(235_000 / 300_000);
    expect(p.rentFils).toBe(45_000);
    expect(p.fixedCosts).toEqual([
      { name: "Salaries", category: "payroll", fils: 45_161 },
      { name: "Machine lease", category: "lease", fils: 8_065 },
    ]);
    expect(p.operatingCostsFils).toBe(45_000 + 45_161 + 8_065);
    expect(p.operatingProfitFils).toBe(136_774);
  });

  it("the machine lease stops after 31 Dec 2026", () => {
    expect(computeDailyPnl(day("2026-12-31"), [lease], [], cfg).fixedCosts).toHaveLength(1);
    expect(computeDailyPnl(day("2027-01-01"), [lease], [], cfg).fixedCosts).toHaveLength(0);
  });

  it("costs don't apply before their start date", () => {
    expect(computeDailyPnl(day("2026-10-07"), [payroll], [], cfg).fixedCosts).toHaveLength(0);
  });

  it("includes one-off costs on their date only", () => {
    const oneOff = [{ name: "Grinder service", category: "maintenance", amountFils: 35_000, date: "2026-11-02" }];
    expect(computeDailyPnl(day("2026-11-01"), [], oneOff, cfg).oneOffCosts).toHaveLength(0);
    const p = computeDailyPnl(day("2026-11-02"), [], oneOff, cfg);
    expect(p.oneOffCosts[0].fils).toBe(35_000);
    expect(p.operatingProfitFils).toBe(235_000 - 45_000 - 35_000);
  });

  it("a zero-sales day still carries fixed costs and has 0% margin (not NaN)", () => {
    const p = computeDailyPnl(day("2026-11-03", { netExVatFils: 0, cogsFils: 0, wasteFils: 0, orders: 0 }), [payroll], [], cfg);
    expect(p.grossMarginPct).toBe(0);
    expect(p.rentFils).toBe(0);
    expect(p.operatingProfitFils).toBe(-dailyShareOfMonthly(1_400_000, "2026-11-03", 8));
  });
});

describe("sumPnl", () => {
  it("over a full business month, fixed costs total exactly the monthly amounts", () => {
    const m = businessMonth("2026-11-20");
    const days = eachDay(m.start, m.end).map((d) => computeDailyPnl(day(d), [payroll, lease], [], cfg));
    const t = sumPnl(days);
    expect(t.days).toBe(30);
    expect(t.costsByCategory.payroll).toBe(1_400_000);
    expect(t.costsByCategory.lease).toBe(250_000);
    expect(t.rentFils).toBe(30 * 45_000);
    expect(t.netSalesFils).toBe(30 * 300_000);
    expect(t.operatingProfitFils).toBe(t.grossProfitFils - t.rentFils - t.fixedCostsFils);
  });

  it("rent only counts days from 1 Nov when the range spans the start", () => {
    const days = eachDay("2026-10-30", "2026-11-02").map((d) => computeDailyPnl(day(d), [], [], cfg));
    expect(sumPnl(days).rentFils).toBe(2 * 45_000);
  });
});

describe("capital payback", () => {
  const base = {
    capitalFils: 16_000_000, tradingStart: "2026-10-08", targetMonths: 12, asOf: "2026-11-01",
    cumulativeOperatingProfitFils: 2_000_000, distributedFils: 0, recentProfitFils: 1_400_000, recentDays: 28,
  };

  it("target is 12 months from 8 Oct 2026 → 7 Oct 2027", () => expect(computePayback(base).targetDate).toBe("2027-10-07"));
  it("straight-line pace is AED 13,333.33 a month", () => expect(computePayback(base).requiredPerMonthFils).toBe(1_333_333));

  it("projects from the trailing run-rate", () => {
    const p = computePayback(base);
    expect(p.recoveredFils).toBe(2_000_000);
    expect(p.remainingFils).toBe(14_000_000);
    expect(p.pctRecovered).toBeCloseTo(0.125);
    expect(p.daysElapsed).toBe(25);
    expect(p.daysLeft).toBe(340);
    // AED 500/day → 140,000 / 500 = 280 days after 1 Nov 2026
    expect(p.projectedPaybackDate).toBe("2027-08-08");
    expect(p.onTrack).toBe(true);
    expect(p.requiredPerMonthFromNowFils).toBe(1_253_309);
  });

  it("is behind target when the run-rate is too slow", () => {
    const p = computePayback({ ...base, recentProfitFils: 280_000 }); // AED 100/day
    expect(p.projectedPaybackDate! > p.targetDate).toBe(true);
    expect(p.onTrack).toBe(false);
  });

  it("no projection when losing money", () => {
    const p = computePayback({ ...base, cumulativeOperatingProfitFils: -500_000, recentProfitFils: -10_000 });
    expect(p.recoveredFils).toBe(0);
    expect(p.projectedPaybackDate).toBeNull();
    expect(p.onTrack).toBe(false);
  });

  it("fully paid back", () => {
    const p = computePayback({ ...base, cumulativeOperatingProfitFils: 16_500_000 });
    expect(p.remainingFils).toBe(0);
    expect(p.projectedPaybackDate).toBe("2026-11-01");
    expect(p.onTrack).toBe(true);
  });

  it("addMonths clamps to month end", () => expect(addMonths("2027-01-31", 1)).toBe("2027-02-28"));
});
