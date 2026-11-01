/**
 * VAT periods and the 13-week cash-flow forecast — pure functions.
 */
import { addDays, addMonths, eachDay, type ISODate } from "./periods.js";
import type { FixedCost } from "./pnl.js";

/** UAE VAT quarter containing `d`. Return and payment are due 28 days after the period ends. */
export function vatQuarter(d: ISODate, startMonth = 1): { start: ISODate; end: ISODate; due: ISODate } {
  const [y, m] = d.split("-").map(Number);
  const offset = (((m - startMonth) % 3) + 3) % 3;
  let sm = m - offset, sy = y;
  if (sm < 1) { sm += 12; sy -= 1; }
  const start = `${sy}-${String(sm).padStart(2, "0")}-01`;
  const end = addDays(addMonths(start, 3), -1);
  return { start, end, due: addDays(end, 28) };
}

export interface ForecastInput {
  start: ISODate;                  // first forecast day
  weeks: number;
  openingFils: number;
  dailyTakingsInclVatFils: number; // what customers pay per day (cash + card)
  dailyNetExVatFils: number;       // for rent
  dailyPurchasesExVatFils: number; // restocking spend (≈ COGS + waste in steady state)
  vatRate: number;
  rentPct: number;
  rentStartDate: ISODate;
  fixed: FixedCost[];              // monthly costs, paid in full on the business month start day (salaries on the 8th)
  businessMonthStartDay: number;
  vatPayments: { date: ISODate; amountFils: number }[];
}

export interface ForecastWeek {
  weekStart: ISODate;
  weekEnd: ISODate;
  takingsFils: number;
  purchasesFils: number;  // incl. input VAT
  rentFils: number;
  fixedCostsFils: number;
  vatPaidFils: number;
  netFils: number;
  closingFils: number;
  events: string[];
}

export function forecastCash(i: ForecastInput): ForecastWeek[] {
  const weeks: ForecastWeek[] = [];
  let balance = i.openingFils;
  for (let w = 0; w < i.weeks; w++) {
    const weekStart = addDays(i.start, w * 7);
    const weekEnd = addDays(weekStart, 6);
    let takings = 0, purchases = 0, rent = 0, fixed = 0, vat = 0;
    const events: string[] = [];
    for (const d of eachDay(weekStart, weekEnd)) {
      takings += i.dailyTakingsInclVatFils;
      purchases += i.dailyPurchasesExVatFils * (1 + i.vatRate);
      if (d >= i.rentStartDate) rent += i.dailyNetExVatFils * i.rentPct;
      if (Number(d.slice(8, 10)) === i.businessMonthStartDay) {
        const due = i.fixed.filter((c) => c.startDate <= d && (c.endDate === null || d <= c.endDate));
        const amt = due.reduce((s, c) => s + c.monthlyFils, 0);
        if (amt) { fixed += amt; events.push(`${d}: monthly costs (${due.map((c) => c.name).join(", ")})`); }
      }
      for (const p of i.vatPayments) if (p.date === d && p.amountFils > 0) { vat += p.amountFils; events.push(`${d}: VAT return payment`); }
    }
    const r = (x: number) => Math.round(x);
    const net = r(takings) - r(purchases) - r(rent) - fixed - vat;
    balance += net;
    weeks.push({ weekStart, weekEnd, takingsFils: r(takings), purchasesFils: r(purchases), rentFils: r(rent), fixedCostsFils: fixed, vatPaidFils: vat, netFils: net, closingFils: balance, events });
  }
  return weeks;
}
