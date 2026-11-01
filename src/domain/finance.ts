/** Finance service: loads costs from the DB and runs the pure P&L / payback maths. */
import type { DB } from "../db/index.js";
import { getNumberSetting, getSetting } from "../db/index.js";
import { computePayback, type PaybackStatus } from "./payback.js";
import { addDays, businessMonth, daysBetweenInclusive, type ISODate } from "./periods.js";
import { forecastCash, vatQuarter, type ForecastWeek } from "./cashflow.js";
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

// ------------------------------------------------------------------ VAT + cash flow (Phase 2)

export interface VatPosition {
  quarter: { start: ISODate; end: ISODate; due: ISODate };
  asOf: ISODate;
  outputVatFils: number;      // collected on sales so far this quarter
  inputVatFils: number;       // paid on supplier deliveries so far this quarter (reclaimable)
  netPayableFils: number;
  projectedNetPayableFils: number; // at quarter end, at the last 28 days' pace
  note: string;
}

/** Input VAT on supplier deliveries (stock lots with a supplier) between two dates. */
function inputVat(db: DB, from: ISODate, to: ISODate): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(qty_received * unit_cost), 0) AS v FROM stock_lots WHERE supplier_id IS NOT NULL AND substr(received_at,1,10) BETWEEN ? AND ?")
    .get(from, to) as any;
  return Math.round(r.v * getNumberSetting(db, "vat_rate"));
}
const outputVat = (db: DB, from: ISODate, to: ISODate) =>
  (db.prepare("SELECT COALESCE(SUM(vat_fils),0) AS v FROM orders WHERE business_date BETWEEN ? AND ?").get(from, to) as any).v as number;

export function vatPosition(db: DB, asOf: ISODate): VatPosition {
  const q = vatQuarter(asOf, getNumberSetting(db, "vat_quarter_start_month"));
  const out = outputVat(db, q.start, asOf);
  const inp = inputVat(db, q.start, asOf);
  const from28 = addDays(asOf, -27);
  const pace = (outputVat(db, from28, asOf) - inputVat(db, from28, asOf)) / 28;
  const remaining = asOf >= q.end ? 0 : daysBetweenInclusive(asOf, q.end) - 1;
  return {
    quarter: q,
    asOf,
    outputVatFils: out,
    inputVatFils: inp,
    netPayableFils: out - inp,
    projectedNetPayableFils: Math.round(out - inp + pace * remaining),
    note: "Input VAT covers supplier deliveries only; add VAT on rent, lease and other expenses when filing.",
  };
}

export interface CashForecast {
  openingFils: number;
  openingKnown: boolean;
  openingDate: ISODate;
  weeks: ForecastWeek[];
  lowestFils: number;
  lowestWeek: ISODate;
  assumptions: string[];
}

export function cashForecast(db: DB, asOf: ISODate, weeks = 13): CashForecast {
  const cfg = pnlConfig(db);
  const start = getSetting(db, "trading_start_date");
  const from = addDays(asOf, -27) < start ? start : addDays(asOf, -27);
  const days = Math.max(1, daysBetweenInclusive(from, asOf));
  const ds = dailySales(db, from, asOf);
  const sum = (f: (d: (typeof ds)[number]) => number) => ds.reduce((s, d) => s + f(d), 0);
  const balRaw = getSetting(db, "cash_balance_fils");
  const openingKnown = balRaw !== "";
  const vatQ = vatPosition(db, asOf);
  const nextQ = vatQuarter(addDays(vatQ.quarter.end, 1), getNumberSetting(db, "vat_quarter_start_month"));
  const pacePerDay = vatQ.projectedNetPayableFils === vatQ.netPayableFils ? 0 : (vatQ.projectedNetPayableFils - vatQ.netPayableFils) / Math.max(1, daysBetweenInclusive(asOf, vatQ.quarter.end) - 1);
  const nextQDays = daysBetweenInclusive(nextQ.start, nextQ.end);
  const { fixed } = loadCosts(db);
  const result = forecastCash({
    start: addDays(asOf, 1),
    weeks,
    openingFils: openingKnown ? Number(balRaw) : 0,
    dailyTakingsInclVatFils: sum((d) => d.grossFils - d.discountFils) / days,
    dailyNetExVatFils: sum((d) => d.netExVatFils) / days,
    dailyPurchasesExVatFils: sum((d) => d.cogsFils + d.wasteFils) / days,
    vatRate: getNumberSetting(db, "vat_rate"),
    rentPct: cfg.rentPct,
    rentStartDate: cfg.rentStartDate,
    fixed,
    businessMonthStartDay: cfg.businessMonthStartDay,
    vatPayments: [
      { date: vatQ.quarter.due, amountFils: Math.max(0, vatQ.projectedNetPayableFils) },
      { date: nextQ.due, amountFils: Math.max(0, Math.round(pacePerDay * nextQDays)) },
    ],
  });
  const lowest = result.reduce((m, w) => (w.closingFils < m.closingFils ? w : m), result[0]);
  return {
    openingFils: openingKnown ? Number(balRaw) : 0,
    openingKnown,
    openingDate: openingKnown ? getSetting(db, "cash_balance_date") || asOf : asOf,
    weeks: result,
    lowestFils: lowest.closingFils,
    lowestWeek: lowest.weekStart,
    assumptions: [
      `Takings, rent and restocking at the average of ${from} → ${asOf} (${days} days).`,
      "Salaries and other monthly costs paid in full on the 8th.",
      "VAT paid 28 days after each quarter ends.",
      openingKnown ? "Opening balance as recorded by an owner." : "No opening balance recorded — figures show the change from today. Set it with: liwan cash --balance <AED>",
    ],
  };
}
