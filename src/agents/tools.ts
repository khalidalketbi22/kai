/**
 * In-process MCP server exposing The Liwan's data to the agents.
 *
 * Phase 1 tools are READ-ONLY. Nothing here can spend money, change stock or contact a supplier.
 * (Phase 2 adds propose_* tools that create pending approval actions — still never a direct send.)
 *
 * All money in tool output is converted from fils to AED (keys ending in `Fils` → `Aed`) so the model
 * reads plain dirham amounts and never has to do unit conversions itself.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DB } from "../db/index.js";
import { loadRecipeBook, currentUnitCost, expiryAlerts, shortfalls, stockStatus } from "../domain/inventory.js";
import { cashForecast, paybackStatus, pnlRange, vatPosition } from "../domain/finance.js";
import { listActions } from "../domain/approvals.js";
import { listPurchaseOrders, planFromDb, proposePurchaseOrders } from "../domain/purchasing.js";
import { generateRota } from "../domain/rota.js";
import { hoursSummary, listPayrollRuns, listStaff, payrollPeriod, preparePayrollRun, previewPayroll, restDayName, shiftTemplates, shiftsBetween, weekRota, weekStartOf } from "../domain/staff.js";
import { addDays, todayInDubai } from "../domain/periods.js";
import { itemPerformance, latestBusinessDate, menuMargins, peakHours, salesSummary } from "../domain/sales.js";
import { buildDailyReport, buildWeeklyReport } from "../reports/reports.js";

export const SERVER_NAME = "liwan";
export const toolId = (name: string) => `mcp__${SERVER_NAME}__${name}`;

/** Recursively rename `xFils` → `xAed` and divide by 100; round unit-level quantities for readability. */
export function toAedView(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toAedView);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.endsWith("Fils") && typeof val === "number") out[k.slice(0, -4) + "Aed"] = Math.round(val) / 100;
      else if (k === "costsByCategory" && val && typeof val === "object")
        out.costsByCategoryAed = Object.fromEntries(Object.entries(val).map(([c, f]) => [c, Math.round(f as number) / 100]));
      else if (typeof val === "number" && /Pct$|^share|^pct/.test(k)) out[k] = Math.round(val * 1000) / 10; // as percentage
      else out[k] = toAedView(val);
    }
    return out;
  }
  return v;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD (Asia/Dubai business date)");

/** Default date for questions like "today": latest day with sales, else today in Dubai. */
export const defaultDate = (db: DB) => latestBusinessDate(db) ?? todayInDubai();

/** Plain handlers (unit-testable without the SDK). Each returns a JSON-serialisable object. */
export function toolHandlers(db: DB) {
  const d = (x?: string) => x ?? defaultDate(db);
  return {
    get_data_freshness: async () => {
      const last = db.prepare("SELECT file_name, imported_at, orders_new FROM sales_imports ORDER BY id DESC LIMIT 1").get() as any;
      return { todayInDubai: todayInDubai(), latestSalesDate: latestBusinessDate(db), lastImport: last ?? null };
    },
    get_stock_status: async (a: { date?: string }) => ({ date: d(a.date), items: stockStatus(db, d(a.date)) }),
    get_stock_alerts: async (a: { date?: string }) => {
      const date = d(a.date);
      return {
        date,
        lowOrOut: stockStatus(db, date).filter((s) => s.state !== "ok"),
        expiringOrExpired: expiryAlerts(db, date),
        shortfallsLast7Days: shortfalls(db, addDays(date, -6), date),
      };
    },
    get_ingredient_usage: async (a: { from: string; to: string }) => ({
      from: a.from,
      to: a.to,
      usage: (
        db
          .prepare(
            `SELECT i.code, i.name_en AS name, i.unit, m.reason, ROUND(-SUM(m.qty), 2) AS qty, ROUND(-SUM(m.cost_fils)) AS costFils
             FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id
             WHERE m.qty < 0 AND substr(m.at,1,10) BETWEEN ? AND ? GROUP BY i.id, m.reason ORDER BY i.name_en, m.reason`,
          )
          .all(a.from, a.to) as any[]
      ),
    }),
    get_recipe: async (a: { sku: string }) => {
      const m = db.prepare("SELECT id, sku, name_en, name_ar, price_incl_vat_fils FROM menu_items WHERE sku = ? OR lower(name_en) = lower(?)").get(a.sku, a.sku) as any;
      if (!m) return { error: `No menu item with SKU or name "${a.sku}"` };
      const book = loadRecipeBook(db);
      const names = new Map((db.prepare("SELECT id, name_en, unit FROM ingredients").all() as any[]).map((r) => [r.id, r]));
      return {
        sku: m.sku,
        name: m.name_en,
        nameAr: m.name_ar,
        priceInclVatFils: m.price_incl_vat_fils,
        components: (book.recipes.get(m.id) ?? []).map((c) => ({
          ingredient: names.get(c.ingredientId)?.name_en,
          qty: c.qty,
          unit: names.get(c.ingredientId)?.unit,
          costFils: c.qty * currentUnitCost(db, c.ingredientId),
        })),
      };
    },
    get_sales_summary: async (a: { from: string; to: string }) => salesSummary(db, a.from, a.to),
    get_item_performance: async (a: { from: string; to: string }) => ({ from: a.from, to: a.to, items: itemPerformance(db, a.from, a.to) }),
    get_peak_hours: async (a: { from: string; to: string }) => ({ from: a.from, to: a.to, hours: peakHours(db, a.from, a.to) }),
    get_menu_margins: async () => ({ note: "Theoretical margin at latest purchase costs, price ex-VAT", items: menuMargins(db) }),
    get_pnl: async (a: { from: string; to: string }) => {
      const p = pnlRange(db, a.from, a.to);
      return { totals: p.totals, days: p.days.map((x) => ({ date: x.date, netSalesFils: x.netSalesFils, grossMarginPct: x.grossMarginPct, rentFils: x.rentFils, operatingProfitFils: x.operatingProfitFils })) };
    },
    get_payback: async (a: { date?: string }) => paybackStatus(db, d(a.date)),
    get_daily_report: async (a: { date?: string }) => buildDailyReport(db, d(a.date)),
    get_weekly_report: async (a: { end_date?: string }) => buildWeeklyReport(db, d(a.end_date)),
    get_purchase_plan: async (a: { date?: string }) => ({
      date: d(a.date),
      note: "Dry run — nothing has been created. Ingredients already on an open order are excluded.",
      orders: planFromDb(db, d(a.date)),
    }),
    propose_purchase_orders: async (a: { date?: string }) => {
      const created = proposePurchaseOrders(db, d(a.date), "purchasing-agent");
      return created.length
        ? { created: created.map((c) => ({ actionId: c.actionId, poId: c.poId, supplier: c.order.supplierName, totalFils: c.order.totalFils, vatFils: c.order.vatFils, belowMinimum: c.order.belowMinimum, lines: c.order.lines.length })),
            note: "Orders are WAITING FOR AN OWNER'S APPROVAL in the dashboard (Approvals). Nothing has been sent to any supplier." }
        : { created: [], note: "Nothing needs ordering (or it is already on an open order)." };
    },
    get_pending_approvals: async () => ({ pending: listActions(db, ["pending_approval"]) }),
    get_purchase_orders: async (a: { status?: string }) => ({ orders: listPurchaseOrders(db, a.status ? [a.status] : undefined, 20) }),
    get_vat_position: async (a: { date?: string }) => vatPosition(db, d(a.date)),
    get_cash_forecast: async (a: { date?: string; weeks?: number }) => cashForecast(db, d(a.date), a.weeks ?? 13),
    // Staff — bank details and ID numbers are deliberately left out of everything the model sees.
    get_staff: async () => ({
      staff: listStaff(db).map((s) => ({ id: s.id, name: s.name, role: s.role, restDay: restDayName(s.restDay), maxWeeklyHours: s.maxWeeklyHours, startDate: s.startDate, endDate: s.endDate,
        monthlyPackageFils: s.basicFils + s.housingFils + s.transportFils + s.otherFils, basicFils: s.basicFils })),
      shiftTemplates: shiftTemplates(db),
    }),
    get_rota: async (a: { week_start?: string }) => {
      const r = weekRota(db, weekStartOf(a.week_start ?? todayInDubai()));
      return { ...r, shifts: r.shifts.map(({ id, staffName, date, template, start, end, status, hours }) => ({ id, staffName, date, template, start, end, status, hours })) };
    },
    get_rota_plan: async (a: { week_start?: string }) => {
      const ws = weekStartOf(a.week_start ?? todayInDubai());
      const existing = shiftsBetween(db, ws, addDays(ws, 6)).map((s) => ({ date: s.date, staffId: s.staffId, template: s.template, start: s.start, end: s.end, breakMinutes: s.breakMinutes }));
      const staff = listStaff(db);
      const plan = generateRota(ws, staff, shiftTemplates(db), existing);
      const name = new Map(staff.map((s) => [s.id, s.name]));
      return { weekStart: ws, note: "Dry run — an owner creates the rota in the dashboard (Staff) or with `liwan rota --generate`.",
        wouldAdd: plan.shifts.map((x) => ({ ...x, staff: name.get(x.staffId) })), gaps: plan.gaps };
    },
    get_hours: async (a: { from: string; to: string }) => ({ from: a.from, to: a.to, staff: hoursSummary(db, a.from, a.to) }),
    get_payroll_preview: async (a: { date?: string }) => {
      const p = payrollPeriod(db, a.date ?? todayInDubai());
      return { period: p, lines: previewPayroll(db, p), recentRuns: listPayrollRuns(db, 3).map(({ lines, sheetPath, ...r }) => r) };
    },
    propose_payroll_run: async (a: { date?: string }) => {
      const { run, created } = preparePayrollRun(db, a.date ?? todayInDubai(), "staff-agent");
      return { created, run: { number: run.number, periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate, status: run.status, netFils: run.netFils, staff: run.lines.length },
        note: created ? "Payroll is WAITING FOR AN OWNER'S APPROVAL (dashboard → Approvals). No money has moved." : `A payroll run for this period already exists (${run.status}).` };
    },
  };
}

export type ToolName = keyof ReturnType<typeof toolHandlers>;

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(toAedView(x)) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return json(await fn(a));
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
  }
};

export function createLiwanMcpServer(db: DB) {
  const h = toolHandlers(db);
  const range = { from: DATE, to: DATE };
  const ro = { annotations: { readOnlyHint: true } };
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool("get_data_freshness", "Today's date in Dubai, the latest date with imported sales, and the last import. Call first when dates are ambiguous.", {}, wrap(h.get_data_freshness), ro),
      tool("get_stock_status", "Stock on hand for every ingredient: qty, reorder point, par, 7-day average usage, days of cover, state (ok/low/out), next expiry, value.", { date: DATE.optional() }, wrap(h.get_stock_status), ro),
      tool("get_stock_alerts", "Only the problems: low/out-of-stock ingredients, lots expiring within 2 days or expired, and sales recorded beyond stock on record (shortfalls).", { date: DATE.optional() }, wrap(h.get_stock_alerts), ro),
      tool("get_ingredient_usage", "Ingredient consumption in a date range, split by reason (sale, waste, staff_drink, sample, count_adjust), with cost.", range, wrap(h.get_ingredient_usage), ro),
      tool("get_recipe", "Recipe for a menu item (by SKU or English name): ingredients, quantities and cost per item at latest purchase prices.", { sku: z.string() }, wrap(h.get_recipe), ro),
      tool("get_sales_summary", "Orders, items, gross/discount/VAT/net sales, COGS, average ticket for a date range.", range, wrap(h.get_sales_summary), ro),
      tool("get_item_performance", "Per menu item for a date range: qty sold, net revenue, COGS, margin, share of sales. Sorted best → worst, zero sellers included.", range, wrap(h.get_item_performance), ro),
      tool("get_peak_hours", "Orders and net sales by hour of day for a date range, with average orders per trading day.", range, wrap(h.get_peak_hours), ro),
      tool("get_menu_margins", "Theoretical margin per drink at current ingredient costs: price ex-VAT, recipe cost, margin AED and %.", {}, wrap(h.get_menu_margins), ro),
      tool("get_pnl", "Profit & loss for a date range: net sales, COGS, waste, gross margin, rent (15% from 1 Nov 2026), fixed costs pro-rated over the 8th→7th month, operating profit.", range, wrap(h.get_pnl), ro),
      tool("get_payback", "Progress toward returning the owners' AED 160,000 capital within 12 months: recovered, remaining, run-rate, projected date, on track or not.", { date: DATE.optional() }, wrap(h.get_payback), ro),
      tool("get_daily_report", "Everything for the daily summary in one call: sales vs last week, P&L, month-to-date, best/worst, peak hour, stock alerts, payback.", { date: DATE.optional() }, wrap(h.get_daily_report), ro),
      tool("get_purchase_plan", "Dry run of what should be ordered now, per supplier: packs, cost, reasons, minimum-order check. Creates nothing.", { date: DATE.optional() }, wrap(h.get_purchase_plan), ro),
      tool(
        "propose_purchase_orders",
        "Create purchase orders for everything that needs reordering, as DRAFTS WAITING FOR OWNER APPROVAL. Does not contact suppliers or spend money. Safe to call again: items already on an open order are skipped.",
        { date: DATE.optional() },
        wrap(h.propose_purchase_orders),
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
      ),
      tool("get_pending_approvals", "Actions waiting for an owner's approval (purchase orders, later payments).", {}, wrap(h.get_pending_approvals), ro),
      tool("get_purchase_orders", "Recent purchase orders with lines and status (pending_approval, approved, sent, received, cancelled).", { status: z.string().optional() }, wrap(h.get_purchase_orders), ro),
      tool("get_vat_position", "UAE VAT for the current quarter: output VAT on sales, input VAT on supplier deliveries, net payable now and projected at quarter end, due date.", { date: DATE.optional() }, wrap(h.get_vat_position), ro),
      tool("get_cash_forecast", "Week-by-week cash-flow forecast (default 13 weeks): takings, restocking, rent, salaries/fixed costs on the 8th, VAT payments, closing balance, lowest point.", { date: DATE.optional(), weeks: z.number().int().min(1).max(26).optional() }, wrap(h.get_cash_forecast), ro),
      tool("get_staff", "Staff list: role, rest day, weekly hour cap, start/end dates, monthly package. Also the shift templates.", {}, wrap(h.get_staff), ro),
      tool("get_rota", "The rota for the Monday–Sunday week containing week_start: shifts, uncovered shifts (gaps) and compliance warnings.", { week_start: DATE.optional() }, wrap(h.get_rota), ro),
      tool("get_rota_plan", "Dry run: who the rota generator would put on each empty shift that week, and which shifts would stay uncovered. Creates nothing.", { week_start: DATE.optional() }, wrap(h.get_rota_plan), ro),
      tool("get_hours", "Hours per person in a date range: shifts, hours, overtime hours, absent / sick / leave days.", range, wrap(h.get_hours), ro),
      tool("get_payroll_preview", "Payroll preview for the business month (8th → 7th) containing date: per-person basic, allowances, overtime, absence deductions, adjustments, net. Plus recent runs.", { date: DATE.optional() }, wrap(h.get_payroll_preview), ro),
      tool(
        "propose_payroll_run",
        "Draft the payroll run for the period containing date, WAITING FOR OWNER APPROVAL. Moves no money. Safe to call again: returns the existing run for that period.",
        { date: DATE.optional() },
        wrap(h.propose_payroll_run),
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
      ),
      tool("get_weekly_report", "Everything for the weekly report (7 days ending end_date): sales vs previous week, P&L, best/worst, peak hours, stock alerts, payback.", { end_date: DATE.optional() }, wrap(h.get_weekly_report), ro),
    ],
  });
}
