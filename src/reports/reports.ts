/**
 * Deterministic report builders. Every number in a summary comes from here — agents only add commentary.
 */
import type { DB } from "../db/index.js";
import { expiryAlerts, shortfalls, stockStatus, type ExpiryAlert, type StockRow } from "../domain/inventory.js";
import { formatAed } from "../domain/money.js";
import { addDays, type ISODate } from "../domain/periods.js";
import { paybackStatus, pnlBusinessMonthToDate, pnlRange } from "../domain/finance.js";
import type { PaybackStatus } from "../domain/payback.js";
import type { DailyPnl, PnlTotals } from "../domain/pnl.js";
import { bestAndWorst, peakHours, salesSummary, type HourBucket, type ItemPerformance, type SalesSummary } from "../domain/sales.js";

export interface DailyReport {
  kind: "daily";
  date: ISODate;
  sales: SalesSummary;
  sameDayLastWeek: SalesSummary;
  pnl: DailyPnl;
  monthToDate: { start: ISODate; end: ISODate; totals: PnlTotals };
  best: ItemPerformance[];
  worst: ItemPerformance[];
  peakHour: HourBucket | null;
  lowStock: StockRow[];
  expiring: ExpiryAlert[];
  shortfalls: { code: string; nameEn: string; nameAr: string; unit: string; qty: number }[];
  payback: PaybackStatus;
}

export function buildDailyReport(db: DB, date: ISODate): DailyReport {
  const mtd = pnlBusinessMonthToDate(db, date);
  const bw = bestAndWorst(db, date, date, 3);
  const hours = peakHours(db, date, date);
  return {
    kind: "daily",
    date,
    sales: salesSummary(db, date, date),
    sameDayLastWeek: salesSummary(db, addDays(date, -7), addDays(date, -7)),
    pnl: pnlRange(db, date, date).days[0],
    monthToDate: { start: mtd.month.start, end: mtd.month.end, totals: mtd.totals },
    best: bw.best,
    worst: bw.worst,
    peakHour: hours.length ? hours.reduce((a, b) => (b.orders > a.orders ? b : a)) : null,
    lowStock: stockStatus(db, date).filter((s) => s.state !== "ok"),
    expiring: expiryAlerts(db, date),
    shortfalls: shortfalls(db, date, date),
    payback: paybackStatus(db, date),
  };
}

export interface WeeklyReport {
  kind: "weekly";
  from: ISODate;
  to: ISODate;
  sales: SalesSummary;
  previousWeek: SalesSummary;
  pnl: PnlTotals;
  daily: DailyPnl[];
  best: ItemPerformance[];
  worst: ItemPerformance[];
  peakHours: HourBucket[];
  lowStock: StockRow[];
  expiring: ExpiryAlert[];
  shortfalls: { code: string; nameEn: string; nameAr: string; unit: string; qty: number }[];
  payback: PaybackStatus;
}

export function buildWeeklyReport(db: DB, endDate: ISODate): WeeklyReport {
  const from = addDays(endDate, -6);
  const p = pnlRange(db, from, endDate);
  const bw = bestAndWorst(db, from, endDate, 3);
  return {
    kind: "weekly",
    from,
    to: endDate,
    sales: salesSummary(db, from, endDate),
    previousWeek: salesSummary(db, addDays(from, -7), addDays(endDate, -7)),
    pnl: p.totals,
    daily: p.days,
    best: bw.best,
    worst: bw.worst,
    peakHours: peakHours(db, from, endDate),
    lowStock: stockStatus(db, endDate).filter((s) => s.state !== "ok"),
    expiring: expiryAlerts(db, endDate),
    shortfalls: shortfalls(db, from, endDate),
    payback: paybackStatus(db, endDate),
  };
}

// ---------------------------------------------------------------- rendering

export type Locale = "en" | "ar";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const change = (now: number, before: number) => (before === 0 ? "n/a" : `${now >= before ? "+" : ""}${(((now - before) / before) * 100).toFixed(0)}%`);
const aed = (f: number) => formatAed(f, { decimals: 0 });
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`;
const qtyLabel = (q: number, unit: string) => (unit === "pc" ? `${Math.round(q)} pcs` : q >= 1000 ? `${(q / 1000).toFixed(1)} ${unit === "g" ? "kg" : "L"}` : `${Math.round(q)} ${unit}`);

const T = {
  en: {
    daily: "The Liwan — daily summary", weekly: "The Liwan — weekly report", sales: "Sales", net: "Net sales (ex-VAT)", orders: "Orders",
    avgTicket: "Avg ticket", vsLastWeek: "vs same day last week", vsPrevWeek: "vs previous week", gm: "Gross margin", op: "Operating profit",
    rent: "Rent (15%)", mtd: "Business month to date", best: "Best sellers", worst: "Slowest sellers", peak: "Peak hour",
    stock: "Stock alerts", low: "low", out: "OUT", cover: "days cover", expiring: "Expiring", expired: "EXPIRED", shortfall: "Sold more than on record (count or delivery missing)",
    payback: "Capital payback", recovered: "recovered", projected: "projected", target: "target", onTrack: "on track", behind: "behind target",
    none: "none", vat: "VAT collected", cogs: "COGS", waste: "Waste & staff drinks",
  },
  ar: {
    daily: "الليوان — الملخص اليومي", weekly: "الليوان — التقرير الأسبوعي", sales: "المبيعات", net: "صافي المبيعات (بدون ضريبة)", orders: "الطلبات",
    avgTicket: "متوسط الفاتورة", vsLastWeek: "مقارنة بنفس اليوم الأسبوع الماضي", vsPrevWeek: "مقارنة بالأسبوع السابق", gm: "هامش الربح الإجمالي", op: "الربح التشغيلي",
    rent: "الإيجار (١٥٪)", mtd: "الشهر التشغيلي حتى اليوم", best: "الأكثر مبيعاً", worst: "الأقل مبيعاً", peak: "ساعة الذروة",
    stock: "تنبيهات المخزون", low: "منخفض", out: "نفد", cover: "أيام تغطية", expiring: "ينتهي قريباً", expired: "منتهي", shortfall: "مبيعات أكثر من المخزون المسجل (جرد أو توريد ناقص)",
    payback: "استرداد رأس المال", recovered: "مسترد", projected: "المتوقع", target: "الهدف", onTrack: "على المسار", behind: "متأخر عن الهدف",
    none: "لا يوجد", vat: "ضريبة القيمة المضافة المحصلة", cogs: "تكلفة البضاعة", waste: "الهدر ومشروبات الموظفين",
  },
} as const;

const itemName = (i: ItemPerformance, l: Locale) => (l === "ar" ? i.nameAr : i.nameEn);
const stockName = (s: { nameEn: string; nameAr?: string }, l: Locale) => (l === "ar" && s.nameAr ? s.nameAr : s.nameEn);

function stockLines(r: { lowStock: StockRow[]; expiring: ExpiryAlert[]; shortfalls: DailyReport["shortfalls"] }, l: Locale): string[] {
  const t = T[l];
  const lines: string[] = [];
  for (const s of r.lowStock) {
    lines.push(`• ${stockName(s, l)}: ${qtyLabel(Math.max(0, s.onHand), s.unit)} (${s.state === "out" ? t.out : t.low}${s.daysOfCover !== null ? `, ${s.daysOfCover} ${t.cover}` : ""})`);
  }
  for (const e of r.expiring) lines.push(`• ${e.expired ? t.expired : t.expiring}: ${stockName(e, l)} ${qtyLabel(e.qtyRemaining, e.unit)} — ${e.expiresAt}`);
  if (r.shortfalls.length) lines.push(`• ${t.shortfall}: ${r.shortfalls.map((s) => `${stockName(s, l)} ${qtyLabel(s.qty, s.unit)}`).join(", ")}`);
  return lines.length ? lines : [`• ${t.none}`];
}

function paybackLine(p: PaybackStatus, l: Locale): string {
  const t = T[l];
  return `${aed(p.recoveredFils)} / ${aed(p.capitalFils)} ${t.recovered} (${pct(p.pctRecovered)}) · ${t.projected} ${p.projectedPaybackDate ?? "—"} · ${t.target} ${p.targetDate} · ${p.onTrack ? t.onTrack : t.behind}`;
}

export function renderDailyText(r: DailyReport, l: Locale = "en"): string {
  const t = T[l];
  const s = r.sales;
  return [
    `☕ ${t.daily} · ${r.date}`,
    ``,
    `*${t.sales}*`,
    `${t.net}: ${aed(s.netExVatFils)} (${change(s.netExVatFils, r.sameDayLastWeek.netExVatFils)} ${t.vsLastWeek})`,
    `${t.orders}: ${s.orders} · ${t.avgTicket}: ${formatAed(s.avgTicketInclVatFils)}`,
    `${t.gm}: ${pct(r.pnl.grossMarginPct)} · ${t.rent}: ${aed(r.pnl.rentFils)} · ${t.op}: ${aed(r.pnl.operatingProfitFils)}`,
    `${t.best}: ${r.best.map((i) => `${itemName(i, l)} (${i.qty})`).join(", ")}`,
    `${t.worst}: ${r.worst.map((i) => `${itemName(i, l)} (${i.qty})`).join(", ")}`,
    r.peakHour ? `${t.peak}: ${hourLabel(r.peakHour.hour)} (${r.peakHour.orders} ${t.orders.toLowerCase()})` : "",
    ``,
    `*${t.mtd}* (${r.monthToDate.start} → ${r.monthToDate.end})`,
    `${t.net}: ${aed(r.monthToDate.totals.netSalesFils)} · ${t.op}: ${aed(r.monthToDate.totals.operatingProfitFils)}`,
    ``,
    `*${t.stock}*`,
    ...stockLines(r, l),
    ``,
    `*${t.payback}*`,
    paybackLine(r.payback, l),
  ]
    .filter((x, i, a) => !(x === "" && a[i - 1] === ""))
    .join("\n");
}

export function renderWeeklyText(r: WeeklyReport, l: Locale = "en"): string {
  const t = T[l];
  const s = r.sales;
  const top3Hours = [...r.peakHours].sort((a, b) => b.orders - a.orders).slice(0, 3);
  return [
    `📊 ${t.weekly} · ${r.from} → ${r.to}`,
    ``,
    `*${t.sales}*`,
    `${t.net}: ${aed(s.netExVatFils)} (${change(s.netExVatFils, r.previousWeek.netExVatFils)} ${t.vsPrevWeek})`,
    `${t.orders}: ${s.orders} (${change(s.orders, r.previousWeek.orders)}) · ${t.avgTicket}: ${formatAed(s.avgTicketInclVatFils)}`,
    `${t.vat}: ${aed(r.pnl.vatCollectedFils)}`,
    ``,
    `*P&L*`,
    `${t.cogs}: ${aed(r.pnl.cogsFils)} · ${t.waste}: ${aed(r.pnl.wasteFils)} · ${t.gm}: ${pct(r.pnl.grossMarginPct)}`,
    `${t.rent}: ${aed(r.pnl.rentFils)} · Fixed costs: ${aed(r.pnl.fixedCostsFils)}`,
    `${t.op}: ${aed(r.pnl.operatingProfitFils)}`,
    ``,
    `${t.best}: ${r.best.map((i) => `${itemName(i, l)} (${i.qty})`).join(", ")}`,
    `${t.worst}: ${r.worst.map((i) => `${itemName(i, l)} (${i.qty})`).join(", ")}`,
    `${t.peak}: ${top3Hours.map((h) => `${hourLabel(h.hour)} (${h.avgOrdersPerDay}/day)`).join(", ")}`,
    ``,
    `*${t.stock}*`,
    ...stockLines(r, l),
    ``,
    `*${t.payback}*`,
    paybackLine(r.payback, l),
  ].join("\n");
}

/**
 * Parameters for the WhatsApp template `liwan_daily_summary` (see docs/whatsapp.md).
 * Meta template params must be single-line, so each is a short phrase.
 */
export function dailyTemplateParams(r: DailyReport, dashboardUrl: string): string[] {
  const alerts = r.lowStock.length + r.expiring.length + (r.shortfalls.length ? 1 : 0);
  return [
    r.date,
    aed(r.sales.netExVatFils),
    String(r.sales.orders),
    formatAed(r.sales.avgTicketInclVatFils),
    pct(r.pnl.grossMarginPct),
    aed(r.pnl.operatingProfitFils),
    alerts === 0 ? "No stock alerts" : `${alerts} stock alert${alerts > 1 ? "s" : ""}: ${[...r.lowStock.map((s) => s.nameEn), ...r.expiring.map((e) => e.nameEn)].slice(0, 4).join(", ")}`,
    `${pct(r.payback.pctRecovered)} of capital back`,
    `${dashboardUrl}/?date=${r.date}`,
  ];
}
