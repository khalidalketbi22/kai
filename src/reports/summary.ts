/**
 * Daily (21:00) and weekly (Sunday) summaries: deterministic report + optional agent insights → owners.
 */
import { config } from "../config.js";
import { poNumber, type CreatedOrder } from "../domain/purchasing.js";
import { DAY_NAMES, type PayrollRunView, type WeekRota } from "../domain/staff.js";
import { dayOfWeek } from "../domain/periods.js";
import type { DB } from "../db/index.js";
import { runOrchestrator } from "../agents/orchestrator.js";
import { notifyOwners } from "../integrations/notify.js";
import type { Notifier } from "../integrations/ports.js";
import { buildDailyReport, buildWeeklyReport, dailyTemplateParams, renderDailyText, renderWeeklyText, type Locale } from "./reports.js";

export interface Insights { en: string; ar: string }

const AR_MARK = "---AR---";

export function parseInsights(text: string): Insights {
  const [en, ar] = text.split(AR_MARK);
  return { en: en.trim(), ar: (ar ?? en).trim() };
}

async function agentInsights(db: DB, kind: "daily_summary" | "weekly_report", date: string): Promise<Insights | null> {
  if (!config.anthropicKeyPresent) return null;
  const tool = kind === "daily_summary" ? `get_daily_report with date ${date}` : `get_weekly_report with end_date ${date}`;
  const prompt = `Call ${tool}. The owners will receive the figures already, so do NOT repeat them.
Write "Insights & actions": at most 3 short bullet points, each one concrete thing worth noticing or doing tomorrow
(e.g. reorder before a stock-out, a slow seller worth promoting, an unusual change vs last week, waste to check).
Spending suggestions must say "needs owner approval". Output the bullets in English, then a line containing only
${AR_MARK}, then the same bullets in Arabic. No preamble.`;
  try {
    return parseInsights((await runOrchestrator(db, prompt, kind)).text);
  } catch (e) {
    console.error(`Agent insights unavailable: ${(e as Error).message}`);
    return null;
  }
}

const withInsights = (body: string, ins: Insights | null, l: Locale) =>
  ins ? `${body}\n\n*${l === "ar" ? "ملاحظات وإجراءات" : "Insights & actions"}*\n${l === "ar" ? ins.ar : ins.en}` : body;

export async function sendDailySummary(db: DB, date: string, opts: { agent?: boolean; notifier?: Notifier | Notifier[] } = {}) {
  const report = buildDailyReport(db, date);
  const insights = opts.agent === false ? null : await agentInsights(db, "daily_summary", date);
  const textFor = (l: Locale) => withInsights(renderDailyText(report, l), insights, l);
  const subjectFor = (l: Locale) =>
    `☕ ${l === "ar" ? "الليوان · الملخص اليومي" : "The Liwan · Daily summary"} ${date} · AED ${Math.round(report.sales.netExVatFils / 100).toLocaleString("en-US")}`;
  const res = await notifyOwners(
    db,
    { textFor, subjectFor, link: `${config.dashboardUrl}/?date=${date}`, template: { name: config.whatsapp.dailyTemplate, params: dailyTemplateParams(report, config.dashboardUrl) } },
    opts.notifier,
  );
  return { report, insights, ...res };
}

export async function sendWeeklyReport(db: DB, endDate: string, opts: { agent?: boolean; notifier?: Notifier | Notifier[] } = {}) {
  const report = buildWeeklyReport(db, endDate);
  const insights = opts.agent === false ? null : await agentInsights(db, "weekly_report", endDate);
  const textFor = (l: Locale) => withInsights(renderWeeklyText(report, l), insights, l);
  const params = [
    `${report.from} → ${report.to}`,
    `AED ${Math.round(report.sales.netExVatFils / 100).toLocaleString("en-US")}`,
    String(report.sales.orders),
    `AED ${Math.round(report.pnl.operatingProfitFils / 100).toLocaleString("en-US")}`,
    `${(report.payback.pctRecovered * 100).toFixed(1)}% of capital back`,
    `${config.dashboardUrl}/sales?to=${report.to}`,
  ];
  const subjectFor = (l: Locale) => `📊 ${l === "ar" ? "الليوان · التقرير الأسبوعي" : "The Liwan · Weekly report"} ${report.from} → ${report.to}`;
  const res = await notifyOwners(db, { textFor, subjectFor, link: `${config.dashboardUrl}/sales?to=${report.to}`, template: { name: config.whatsapp.weeklyTemplate, params } }, opts.notifier);
  return { report, insights, ...res };
}

// ------------------------------------------------------------------ approvals (Phase 2)

/** Tell every owner that new purchase orders are waiting for approval (any one owner can approve). */
export async function notifyApprovalsNeeded(db: DB, created: CreatedOrder[], opts: { notifier?: Notifier | Notifier[] } = {}) {
  if (!created.length) return { sent: 0, failed: 0, skipped: [] as string[] };
  const total = created.reduce((s, c) => s + c.order.totalFils + c.order.vatFils, 0);
  const link = `${config.dashboardUrl}/approvals`;
  const textFor = (l: Locale) => {
    const head = l === "ar" ? `🧾 الليوان — طلبات شراء بانتظار الموافقة (${created.length})` : `🧾 The Liwan — purchase orders waiting for approval (${created.length})`;
    const body = created.map((c) => {
      const o = c.order;
      const items = o.lines.map((x) => `${x.packs}× ${x.packDescription}`).join(", ");
      const min = o.belowMinimum ? (l === "ar" ? " ⚠ أقل من الحد الأدنى للطلب" : " ⚠ below supplier minimum") : "";
      return `• ${poNumber(c.poId)} · ${o.supplierName}: ${items} — AED ${((o.totalFils + o.vatFils) / 100).toFixed(2)}${min}`;
    });
    const foot = l === "ar"
      ? `يكفي موافقة شريك واحد. لن يُرسل أي طلب للمورد قبل الموافقة.\n${link}`
      : `Any one owner can approve. Nothing is sent to a supplier until someone does.\n${link}`;
    return [head, "", ...body, "", foot].join("\n");
  };
  const subjectFor = (l: Locale) =>
    l === "ar" ? `🧾 الليوان · ${created.length} طلب شراء بانتظار الموافقة · AED ${(total / 100).toFixed(0)}` : `🧾 The Liwan · ${created.length} purchase order(s) to approve · AED ${(total / 100).toFixed(0)}`;
  return notifyOwners(db, { textFor, subjectFor, link }, opts.notifier);
}

// ------------------------------------------------------------------ staff (Phase 3)

export async function notifyPayrollNeeded(db: DB, run: PayrollRunView, reminder = false, opts: { notifier?: Notifier | Notifier[] } = {}) {
  const link = `${config.dashboardUrl}/approvals`;
  const aed = (f: number) => `AED ${(f / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const textFor = (l: Locale) => {
    const head = l === "ar"
      ? `💼 الليوان — ${reminder ? "تذكير: " : ""}رواتب ${run.periodStart} → ${run.periodEnd} بانتظار الموافقة`
      : `💼 The Liwan — ${reminder ? "reminder: " : ""}payroll ${run.periodStart} → ${run.periodEnd} waiting for approval`;
    const rows = run.lines.map((x) => `• ${x.name}: ${aed(x.netFils)}${x.notes.length ? ` (${x.notes.join("; ")})` : ""}`);
    const foot = l === "ar"
      ? `الإجمالي ${aed(run.netFils)} · موعد الدفع ${run.payDate}. تكفي موافقة شريك واحد؛ لن تُحوّل أي أموال تلقائياً.\n${link}`
      : `Total ${aed(run.netFils)} · pay date ${run.payDate}. Any one owner can approve; no money moves automatically.\n${link}`;
    return [head, "", ...rows, "", foot].join("\n");
  };
  const subjectFor = (l: Locale) => (l === "ar" ? `💼 الليوان · رواتب ${run.payDate} بانتظار الموافقة · ${aed(run.netFils)}` : `💼 The Liwan · ${reminder ? "Reminder: " : ""}payroll for ${run.payDate} to approve · ${aed(run.netFils)}`);
  return notifyOwners(db, { textFor, subjectFor, link }, opts.notifier);
}

export async function notifyRotaGaps(db: DB, rota: WeekRota, opts: { notifier?: Notifier | Notifier[] } = {}) {
  if (!rota.gaps.length) return { sent: 0, failed: 0, skipped: [] as string[] };
  const link = `${config.dashboardUrl}/staff?week=${rota.weekStart}`;
  const rows = rota.gaps.map((g) => `• ${DAY_NAMES[dayOfWeek(g.date)]} ${g.date}: ${g.label} ${g.start}–${g.end}`);
  const textFor = (l: Locale) =>
    [l === "ar" ? `🗓 الليوان — مناوبات غير مغطاة في أسبوع ${rota.weekStart}` : `🗓 The Liwan — uncovered shifts, week of ${rota.weekStart}`, "", ...rows, "",
      l === "ar" ? `يحتاج أحد الشركاء أو موظف بدوام جزئي لتغطيتها.\n${link}` : `An owner or a part-timer needs to cover these.\n${link}`].join("\n");
  const subjectFor = (l: Locale) => (l === "ar" ? `🗓 الليوان · ${rota.gaps.length} مناوبة غير مغطاة` : `🗓 The Liwan · ${rota.gaps.length} uncovered shift(s) next week`);
  return notifyOwners(db, { textFor, subjectFor, link }, opts.notifier);
}
