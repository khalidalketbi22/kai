/**
 * Daily (21:00) and weekly (Sunday) summaries: deterministic report + optional agent insights → owners.
 */
import { config } from "../config.js";
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

export async function sendDailySummary(db: DB, date: string, opts: { agent?: boolean; notifier?: Notifier } = {}) {
  const report = buildDailyReport(db, date);
  const insights = opts.agent === false ? null : await agentInsights(db, "daily_summary", date);
  const textFor = (l: Locale) => withInsights(renderDailyText(report, l), insights, l);
  const res = await notifyOwners(db, { textFor, template: { name: config.whatsapp.dailyTemplate, params: dailyTemplateParams(report, config.dashboardUrl) } }, opts.notifier);
  return { report, insights, ...res };
}

export async function sendWeeklyReport(db: DB, endDate: string, opts: { agent?: boolean; notifier?: Notifier } = {}) {
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
  const res = await notifyOwners(db, { textFor, template: { name: config.whatsapp.weeklyTemplate, params } }, opts.notifier);
  return { report, insights, ...res };
}
