/**
 * Profit & loss maths — pure functions, no database.
 *
 * Daily P&L for The Liwan:
 *   net sales (ex-VAT, after discounts)
 * − COGS (recipe depletion, costed per stock lot)
 * − waste (stock written off)
 * = gross profit
 * − rent (rent_pct of net sales, only from rent_start_date)
 * − fixed monthly costs, pro-rated over the 8th→7th business month (payroll, machine lease, …)
 * − one-off costs dated that day
 * = operating profit
 */
import { businessMonth, daysBetweenInclusive, type ISODate } from "./periods.js";

export interface DaySales {
  date: ISODate;
  orders: number;
  grossFils: number;       // incl. VAT, before discount
  discountFils: number;
  vatFils: number;         // output VAT collected
  netExVatFils: number;
  cogsFils: number;
  wasteFils: number;
}

export interface FixedCost {
  name: string;
  category: string;
  monthlyFils: number;
  startDate: ISODate;
  endDate: ISODate | null; // inclusive
}

export interface OneOffCost {
  name: string;
  category: string;
  amountFils: number;
  date: ISODate;
}

export interface PnlConfig {
  rentPct: number;
  rentStartDate: ISODate;
  businessMonthStartDay: number;
}

export interface CostLine { name: string; category: string; fils: number }

export interface DailyPnl {
  date: ISODate;
  orders: number;
  netSalesFils: number;
  vatCollectedFils: number;
  cogsFils: number;
  wasteFils: number;
  grossProfitFils: number;
  grossMarginPct: number;
  rentFils: number;
  fixedCosts: CostLine[];
  oneOffCosts: CostLine[];
  operatingCostsFils: number; // rent + fixed + one-off
  operatingProfitFils: number;
}

/**
 * The share of a monthly amount that falls on `date`, within its business month.
 * Uses cumulative rounding so the daily shares of a month add up to exactly `monthlyFils`.
 */
export function dailyShareOfMonthly(monthlyFils: number, date: ISODate, startDay: number): number {
  const m = businessMonth(date, startDay);
  const i = daysBetweenInclusive(m.start, date) - 1; // 0-based index within the month
  return Math.round((monthlyFils * (i + 1)) / m.days) - Math.round((monthlyFils * i) / m.days);
}

export function rentForDay(netSalesFils: number, date: ISODate, cfg: Pick<PnlConfig, "rentPct" | "rentStartDate">): number {
  if (date < cfg.rentStartDate) return 0;
  return Math.round(netSalesFils * cfg.rentPct);
}

const isActive = (c: FixedCost, d: ISODate) => c.startDate <= d && (c.endDate === null || d <= c.endDate);

export function computeDailyPnl(day: DaySales, fixed: FixedCost[], oneOffs: OneOffCost[], cfg: PnlConfig): DailyPnl {
  const grossProfit = day.netExVatFils - day.cogsFils - day.wasteFils;
  const rent = rentForDay(day.netExVatFils, day.date, cfg);

  const fixedCosts: CostLine[] = fixed
    .filter((c) => isActive(c, day.date))
    .map((c) => ({ name: c.name, category: c.category, fils: dailyShareOfMonthly(c.monthlyFils, day.date, cfg.businessMonthStartDay) }));
  const oneOffCosts: CostLine[] = oneOffs
    .filter((c) => c.date === day.date)
    .map((c) => ({ name: c.name, category: c.category, fils: c.amountFils }));

  const operatingCosts = rent + sum(fixedCosts.map((c) => c.fils)) + sum(oneOffCosts.map((c) => c.fils));
  return {
    date: day.date,
    orders: day.orders,
    netSalesFils: day.netExVatFils,
    vatCollectedFils: day.vatFils,
    cogsFils: day.cogsFils,
    wasteFils: day.wasteFils,
    grossProfitFils: grossProfit,
    grossMarginPct: day.netExVatFils === 0 ? 0 : grossProfit / day.netExVatFils,
    rentFils: rent,
    fixedCosts,
    oneOffCosts,
    operatingCostsFils: operatingCosts,
    operatingProfitFils: grossProfit - operatingCosts,
  };
}

export interface PnlTotals {
  from: ISODate;
  to: ISODate;
  days: number;
  orders: number;
  netSalesFils: number;
  vatCollectedFils: number;
  cogsFils: number;
  wasteFils: number;
  grossProfitFils: number;
  grossMarginPct: number;
  rentFils: number;
  fixedCostsFils: number;
  oneOffCostsFils: number;
  operatingProfitFils: number;
  costsByCategory: Record<string, number>;
}

export function sumPnl(days: DailyPnl[]): PnlTotals {
  if (days.length === 0) throw new Error("sumPnl needs at least one day");
  const costsByCategory: Record<string, number> = {};
  for (const d of days) {
    costsByCategory.rent = (costsByCategory.rent ?? 0) + d.rentFils;
    for (const c of [...d.fixedCosts, ...d.oneOffCosts]) costsByCategory[c.category] = (costsByCategory[c.category] ?? 0) + c.fils;
  }
  const net = sum(days.map((d) => d.netSalesFils));
  const gp = sum(days.map((d) => d.grossProfitFils));
  return {
    from: days[0].date,
    to: days[days.length - 1].date,
    days: days.length,
    orders: sum(days.map((d) => d.orders)),
    netSalesFils: net,
    vatCollectedFils: sum(days.map((d) => d.vatCollectedFils)),
    cogsFils: sum(days.map((d) => d.cogsFils)),
    wasteFils: sum(days.map((d) => d.wasteFils)),
    grossProfitFils: gp,
    grossMarginPct: net === 0 ? 0 : gp / net,
    rentFils: sum(days.map((d) => d.rentFils)),
    fixedCostsFils: sum(days.flatMap((d) => d.fixedCosts.map((c) => c.fils))),
    oneOffCostsFils: sum(days.flatMap((d) => d.oneOffCosts.map((c) => c.fils))),
    operatingProfitFils: sum(days.map((d) => d.operatingProfitFils)),
    costsByCategory,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
