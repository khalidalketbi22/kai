/**
 * Schedule (Asia/Dubai):
 *   20:55 daily   import any Foodics CSVs dropped into data/inbox/, then a reorder check
 *   21:00 daily   daily summary → owners
 *   21:05 Sunday  weekly report → owners
 *   :15 hourly, 09:15–20:15   reorder check → purchase orders drafted for owner approval → owners notified
 * Phase 3 adds: 8th-of-month payroll prep.
 */
import cron from "node-cron";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./db/index.js";
import { todayInDubai } from "./domain/periods.js";
import { FoodicsCsvSource } from "./importers/foodics-csv.js";
import { ingestSales } from "./importers/ingest.js";
import { notifyApprovalsNeeded, sendDailySummary, sendWeeklyReport } from "./reports/summary.js";
import { proposePurchaseOrders } from "./domain/purchasing.js";

export async function importInbox(db: DB, inbox = "data/inbox", done = "data/imported") {
  if (!existsSync(inbox)) return [];
  mkdirSync(done, { recursive: true });
  const results = [];
  for (const f of readdirSync(inbox).filter((n) => n.toLowerCase().endsWith(".csv")).sort()) {
    const path = join(inbox, f);
    try {
      const r = ingestSales(db, await new FoodicsCsvSource(path).fetch());
      renameSync(path, join(done, `${new Date().toISOString().slice(0, 19).replace(/:/g, "")}-${f}`));
      results.push({ file: f, ...r });
      console.log(`[inbox] ${f}: ${r.duplicate ? "duplicate, skipped" : `${r.ordersNew} new orders`}`);
    } catch (e) {
      console.error(`[inbox] ${f}: ${(e as Error).message}`);
    }
  }
  return results;
}

export function startScheduler(db: DB): void {
  const tz = "Asia/Dubai";
  const safe = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[scheduler] ${name} failed: ${(e as Error).message}`);
    }
  };
  const reorderCheck = async (by: string) => {
    const created = proposePurchaseOrders(db, todayInDubai(), by);
    if (created.length) {
      console.log(`[reorder] ${created.length} purchase order(s) waiting for approval`);
      await notifyApprovalsNeeded(db, created);
    }
  };
  cron.schedule("15 9-20 * * *", safe("reorder check", () => reorderCheck("purchasing-schedule")), { timezone: tz });
  cron.schedule("55 20 * * *", safe("inbox import + reorder check", async () => {
    await importInbox(db);
    await reorderCheck("purchasing-schedule");
  }), { timezone: tz });
  cron.schedule("0 21 * * *", safe("daily summary", () => sendDailySummary(db, todayInDubai())), { timezone: tz });
  cron.schedule("5 21 * * 0", safe("weekly report", () => sendWeeklyReport(db, todayInDubai())), { timezone: tz });
  console.log("[scheduler] running: reorder check hourly 09:15–20:15, inbox 20:55, daily summary 21:00, weekly report Sun 21:05 (Asia/Dubai)");
}
