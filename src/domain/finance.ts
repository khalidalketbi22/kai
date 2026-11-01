/** Finance service: loads costs from the DB and runs the pure P&L / payback maths. */
import type { DB } from "../db/index.js";
import { getNumberSetting, getSetting } from "../db/index.js";
import { computePayback, type PaybackStatus } from "./payback.js";
import { addDays, businessMonth, type ISODate } from "./periods.js";
import { computeDailyPnl, sumPnl, type DailyPnl, type FixedCost, type OneOffCost, type PnlConfig, type PnlTotals } from "./pnl.js";
import { dailySales } from "./sales.js";

export function pnlConfig(db: DB): PnlConfig {
  return {
    rentPct: getNumberSetting(db, "rent_pct"),
    rentStartDate: getSetting(db, "rent_start_date"),
    businessMonthStartDay: getNumberSetting(db, "business_month_start_day"),
  };
}

export function loadCosts(db: DB): { fixed: FixedCost[]; oneOffs: OneOffCost[] } {
  const rows = db.prepare("SELECT name, category, kind, amount_fils, start_date, end_date FROM expenses").all() as any[];
  return {
    fixed: rows
      .filter((r) => r.kind === "fixed_monthly")
      .map((r) => ({ name: r.name, category: r.category, monthlyFils: r.amount_fils, startDate: r.start_date, endDate: r.end_date })),
    oneOffs: rows
      .filter((r) => r.kind === "one_off")
      .map((r) => ({ name: r.name, category: r.category, amountFils: r.amount_fils, date: r.start_date })),
  };
}

export function pnlRange(db: DB, from: ISODate, to: ISODate): { days: DailyPnl[]; totals: PnlTotals } {
  const cfg = pnlConfig(db);
  const { fixed, oneOffs } = loadCosts(db);
  const days = dailySales(db, from, to).map((d) => computeDailyPnl(d, fixed, oneOffs, cfg));
  return { days, totals: sumPnl(days) };
}

export function pnlBusinessMonthToDate(db: DB, asOf: ISODate) {
  const m = businessMonth(asOf, getNumberSetting(db, "business_month_start_day"));
  return { month: m, ...pnlRange(db, m.start, asOf) };
}

export function paybackStatus(db: DB, asOf: ISODate): PaybackStatus {
  const start = getSetting(db, "trading_start_date");
  const all = asOf >= start ? pnlRange(db, start, asOf).days : [];
  const cumulative = all.reduce((s, d) => s + d.operatingProfitFils, 0);
  // Project with today's cost structure: days before rent started are charged rent as if it applied,
  // so a rent-free opening month doesn't make the payback date look better than it is.
  const cfg = pnlConfig(db);
  const recent = all.slice(-28).map((d) => ({
    ...d,
    operatingProfitFils: d.date < cfg.rentStartDate ? d.operatingProfitFils - Math.round(d.netSalesFils * cfg.rentPct) : d.operatingProfitFils,
  }));
  const distributed = (db.prepare("SELECT COALESCE(SUM(amount_fils),0) AS s FROM distributions WHERE date <= ?").get(asOf) as any).s;
  const capital = (db.prepare("SELECT COALESCE(SUM(amount_fils),0) AS s FROM capital_contributions").get() as any).s || getNumberSetting(db, "capital_target_fils");
  return computePayback({
    capitalFils: capital,
    tradingStart: start,
    targetMonths: getNumberSetting(db, "payback_months"),
    asOf,
    cumulativeOperatingProfitFils: cumulative,
    distributedFils: distributed,
    recentProfitFils: recent.reduce((s, d) => s + d.operatingProfitFils, 0),
    recentDays: recent.length,
  });
}

export const weekRange = (end: ISODate) => ({ from: addDays(end, -6), to: end });
