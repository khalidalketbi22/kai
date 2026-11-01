#!/usr/bin/env node
/**
 * The Liwan Ops CLI.  Usage: npm run liwan -- <command> [options]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config, emailConfigured } from "./config.js";
import { EmailNotifier, textToEmailHtml } from "./integrations/notifiers/email.js";
import { configuredNotifiers } from "./integrations/notify.js";
import { openDb, type DB } from "./db/index.js";
import { currentUnitCost, ingredientIdByCode, recordCount, recordWaste, receiveStock, stockStatus, writeOffExpired } from "./domain/inventory.js";
import { formatAed } from "./domain/money.js";
import { addDays, todayInDubai } from "./domain/periods.js";
import { latestBusinessDate, itemPerformance, peakHours, salesSummary } from "./domain/sales.js";
import { pnlRange } from "./domain/finance.js";
import { FoodicsCsvSource } from "./importers/foodics-csv.js";
import { ingestSales } from "./importers/ingest.js";
import { buildDailyReport, buildWeeklyReport, renderDailyText, renderWeeklyText } from "./reports/reports.js";
import { sendDailySummary, sendWeeklyReport } from "./reports/summary.js";
import { seedReferenceData, simulateHistory } from "./seed/seed.js";
import { generateFoodicsCsv } from "./seed/generate-sales.js";
import { setOwnerPin } from "./web/auth.js";

const HELP = `The Liwan Ops

  setup                              Guided first-time setup: owners, emails, PINs, email account, opening stock.
  seed [--reset] [--empty] [--through 2026-10-31] [--sample-date 2026-11-01]
        Demo database with a simulated trading history (or --empty: menu/recipes/suppliers only),
        and a Foodics sample CSV for the next day in samples/.
  import <file.csv>                  Import a Foodics order-items CSV (idempotent) and deplete stock.
  stock [--date D]                   Stock levels, days of cover and alerts.
  sales [--from D --to D]            Sales summary, best/worst sellers, peak hours (default: last 7 days).
  pnl [--from D --to D]              Profit & loss (default: business month to date).
  summary [--weekly] [--date D] [--send] [--no-agent] [--lang en|ar] [--preview-email file.html]
                                     Print (or --send to owners) the daily summary / weekly report.
  ask "<question>" [--verbose]       Ask the agent team (needs ANTHROPIC_API_KEY).
  receive <ingredient> <packs>       Log a delivery of N supplier packs at the current pack price.
  waste <ingredient> <qty> [--reason waste|staff_drink|sample] [--note text]
  count <ingredient> <qty>           Record a physical stock count (books the difference).
  expire [--date D]                  Write off expired stock lots as waste.
  owners                             List owners and where their reports go.
  owner --name N [--email a@b.com] [--phone +971…] [--pin 1234] [--locale en|ar] [--rename NEW]
  test-email <address>               Send a test email to check the SMTP settings.
  serve [--no-scheduler]             Start the dashboard (+ 21:00 daily / Sunday weekly scheduler).

Ingredient codes: run "stock" to list them. Dates: YYYY-MM-DD.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reset: { type: "boolean" }, empty: { type: "boolean" }, through: { type: "string" }, "sample-date": { type: "string" },
    date: { type: "string" }, from: { type: "string" }, to: { type: "string" },
    weekly: { type: "boolean" }, send: { type: "boolean" }, "no-agent": { type: "boolean" }, lang: { type: "string" },
    verbose: { type: "boolean" }, reason: { type: "string" }, note: { type: "string" },
    name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, "preview-email": { type: "string" }, pin: { type: "string" }, locale: { type: "string" }, rename: { type: "string" },
    "no-scheduler": { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
const aed = (f: number) => formatAed(f, { decimals: 0 });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const defaultDate = (db: DB) => values.date ?? latestBusinessDate(db) ?? todayInDubai();
const nowIso = () => new Date().toISOString().slice(0, 19);

async function main() {
  if (!cmd || values.help) return console.log(HELP);

  if (cmd === "setup") return (await import("./setup.js")).runSetup();

  if (cmd === "seed") {
    if (existsSync(config.dbPath)) {
      if (!values.reset) throw new Error(`${config.dbPath} already exists. Use --reset to wipe and re-seed.`);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(config.dbPath + suffix, { force: true });
    }
    const db = openDb(config.dbPath);
    seedReferenceData(db);
    if (values.empty) return console.log(`Created ${config.dbPath} with menu, recipes and suppliers (no sales). Record opening stock with: count <ingredient> <qty>`);
    const through = values.through ?? "2026-10-31";
    const sim = simulateHistory(db, "2026-10-08", through);
    const sampleDate = values["sample-date"] ?? addDays(through, 1);
    mkdirSync("samples", { recursive: true });
    const samplePath = `samples/foodics-${sampleDate}.csv`;
    writeFileSync(samplePath, generateFoodicsCsv({ from: sampleDate, to: sampleDate }));
    console.log(`Seeded ${config.dbPath}: ${sim.days} trading days, ${sim.orders} orders, ${sim.deliveries} deliveries.`);
    console.log(`Sample POS export for ${sampleDate}: ${samplePath}\nNext: npm run liwan -- import ${samplePath}`);
    return;
  }

  const db = openDb(config.dbPath);

  switch (cmd) {
    case "import": {
      if (!args[0]) throw new Error("Usage: import <file.csv>");
      const r = ingestSales(db, await new FoodicsCsvSource(args[0]).fetch());
      if (r.duplicate) return console.log("Already imported — nothing changed.");
      console.log(`Imported ${r.ordersNew} orders (${r.linesNew} lines)${r.ordersExisting ? `, ${r.ordersExisting} already on record` : ""}, ${r.rowsSkipped} rows skipped. ${r.dateRange ? `${r.dateRange.from} → ${r.dateRange.to}` : ""}`);
      if (r.shortfallIngredients.length) console.log(`⚠ Sold more than stock on record: ${r.shortfallIngredients.join(", ")} — log a delivery or do a count.`);
      r.warnings.slice(0, 20).forEach((w) => console.log(`  ! ${w}`));
      if (r.warnings.length > 20) console.log(`  … ${r.warnings.length - 20} more warnings`);
      return;
    }
    case "stock": {
      const date = defaultDate(db);
      console.log(`Stock as of ${date}\n`);
      console.log(["state", "code".padEnd(16), "on hand".padStart(12), "reorder".padStart(10), "cover", "expiry"].join("  "));
      for (const s of stockStatus(db, date)) {
        console.log([s.state.padEnd(5), s.code.padEnd(16), `${s.onHand} ${s.unit}`.padStart(12), `${s.reorderPoint}`.padStart(10), String(s.daysOfCover ?? "—").padStart(5), s.nextExpiry ?? "—"].join("  "));
      }
      return;
    }
    case "sales": {
      const to = values.to ?? defaultDate(db);
      const from = values.from ?? addDays(to, -6);
      const s = salesSummary(db, from, to);
      console.log(`Sales ${from} → ${to}: net ${aed(s.netExVatFils)} · ${s.orders} orders · ${s.items} items · avg ticket ${formatAed(s.avgTicketInclVatFils)} · VAT ${aed(s.vatFils)}\n`);
      for (const i of itemPerformance(db, from, to)) console.log(`${i.nameEn.padEnd(34)} ${String(i.qty).padStart(5)}  ${aed(i.netExVatFils).padStart(11)}  margin ${pct(i.marginPct)}`);
      console.log("\nOrders by hour:");
      for (const h of peakHours(db, from, to)) console.log(`${String(h.hour).padStart(2, "0")}:00 ${"█".repeat(Math.round(h.avgOrdersPerDay))} ${h.avgOrdersPerDay}/day`);
      return;
    }
    case "pnl": {
      const to = values.to ?? defaultDate(db);
      const from = values.from ?? buildDailyReport(db, to).monthToDate.start;
      const { totals: t } = pnlRange(db, from, to);
      const lines: [string, number][] = [
        ["Net sales (ex-VAT)", t.netSalesFils], ["COGS", -t.cogsFils], ["Waste & staff drinks", -t.wasteFils], ["Gross profit", t.grossProfitFils],
        ["Rent (15%)", -t.rentFils], ...Object.entries(t.costsByCategory).filter(([k]) => k !== "rent").map(([k, v]) => [`  ${k}`, -v] as [string, number]),
        ["Operating profit", t.operatingProfitFils],
      ];
      console.log(`P&L ${from} → ${to} (${t.days} days, ${t.orders} orders) · gross margin ${pct(t.grossMarginPct)} · VAT collected ${aed(t.vatCollectedFils)}\n`);
      for (const [k, v] of lines) console.log(`${k.padEnd(24)} ${aed(v).padStart(14)}`);
      return;
    }
    case "summary": {
      const date = defaultDate(db);
      const lang = values.lang === "ar" ? "ar" : "en";
      if (values.send) {
        const r = values.weekly ? await sendWeeklyReport(db, date, { agent: !values["no-agent"] }) : await sendDailySummary(db, date, { agent: !values["no-agent"] });
        return console.log(`Sent ${r.sent} message(s), ${r.failed} failed.`);
      }
      const text = values.weekly ? renderWeeklyText(buildWeeklyReport(db, date), lang) : renderDailyText(buildDailyReport(db, date), lang);
      if (values["preview-email"]) {
        writeFileSync(values["preview-email"], textToEmailHtml(text, { dashboardUrl: config.dashboardUrl }));
        return console.log(`Email preview written to ${values["preview-email"]}`);
      }
      console.log(text);
      return;
    }
    case "ask": {
      const q = args.join(" ");
      if (!q) throw new Error('Usage: ask "<question>"');
      const { runOrchestrator } = await import("./agents/orchestrator.js");
      const r = await runOrchestrator(db, q, "ask", { verbose: values.verbose });
      console.log(r.text);
      if (values.verbose) console.error(`\n(${r.turns} turns, $${r.costUsd?.toFixed(4)})`);
      return;
    }
    case "receive": {
      const [code, packsRaw] = args;
      const packs = Number(packsRaw);
      if (!code || !(packs > 0)) throw new Error("Usage: receive <ingredient> <packs>");
      const id = ingredientIdByCode(db, code);
      const p = db.prepare(
        `SELECT p.pack_qty, p.price_fils, p.supplier_id, i.unit FROM ingredients i JOIN supplier_products p ON p.ingredient_id = i.id AND p.supplier_id = i.default_supplier_id WHERE i.id = ?`,
      ).get(id) as any;
      receiveStock(db, { ingredientId: id, qty: packs * p.pack_qty, unitCost: p.price_fils / p.pack_qty, receivedAt: nowIso(), supplierId: p.supplier_id });
      return console.log(`Received ${packs} × ${p.pack_qty} ${p.unit} of ${code} (${formatAed(packs * p.price_fils)} ex-VAT).`);
    }
    case "waste": {
      const [code, q] = args;
      if (!code || !(Number(q) > 0)) throw new Error("Usage: waste <ingredient> <qty>");
      const reason = (values.reason ?? "waste") as "waste" | "staff_drink" | "sample";
      const r = recordWaste(db, code, Number(q), nowIso(), values.note ?? reason, reason);
      return console.log(`Logged ${reason}: ${q} of ${code} (cost ${formatAed(Math.round(r.cost))}).`);
    }
    case "count": {
      const [code, q] = args;
      if (!code || q === undefined || !(Number(q) >= 0)) throw new Error("Usage: count <ingredient> <qty>");
      const r = recordCount(db, code, Number(q), nowIso());
      return console.log(`Count recorded for ${code}: adjustment ${r.diff >= 0 ? "+" : ""}${Math.round(r.diff * 100) / 100} (unit cost ${currentUnitCost(db, ingredientIdByCode(db, code)).toFixed(2)} fils).`);
    }
    case "expire": {
      const r = writeOffExpired(db, values.date ?? todayInDubai());
      return console.log(`Wrote off ${r.lots} expired lot(s), cost ${formatAed(Math.round(r.cost))}.`);
    }
    case "owner": {
      if (!values.name) throw new Error("Usage: owner --name N [--email a@b.com] [--phone +971…] [--pin 1234] [--locale en|ar] [--rename NEW]");
      const exists = db.prepare("SELECT id FROM owners WHERE name = ?").get(values.name);
      if (!exists) throw new Error(`No owner named "${values.name}". Owners: ${(db.prepare("SELECT name FROM owners").all() as any[]).map((o) => o.name).join(", ")}`);
      if (values.phone) db.prepare("UPDATE owners SET phone = ? WHERE name = ?").run(values.phone, values.name);
      if (values.email) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) throw new Error(`Not an email address: ${values.email}`);
        db.prepare("UPDATE owners SET email = ? WHERE name = ?").run(values.email, values.name);
      }
      if (values.locale) db.prepare("UPDATE owners SET locale = ? WHERE name = ?").run(values.locale === "ar" ? "ar" : "en", values.name);
      if (values.pin) setOwnerPin(db, values.name, values.pin);
      if (values.rename) db.prepare("UPDATE owners SET name = ? WHERE name = ?").run(values.rename, values.name);
      return console.log(`Updated owner ${values.rename ?? values.name}.`);
    }
    case "owners": {
      const channels = configuredNotifiers().map((n) => n.channel).join(" + ");
      console.log(`Active channels: ${channels}\n`);
      for (const o of db.prepare("SELECT name, email, phone, locale, pin_hash IS NOT NULL AS pin FROM owners ORDER BY id").all() as any[]) {
        console.log(`${o.name.padEnd(14)} email: ${(o.email ?? "—").padEnd(28)} phone: ${(o.phone ?? "—").padEnd(15)} lang: ${o.locale}  dashboard PIN: ${o.pin ? "set" : "—"}`);
      }
      return;
    }
    case "test-email": {
      if (!args[0]) throw new Error("Usage: test-email <address>");
      if (!emailConfigured()) throw new Error("Email is not configured: set SMTP_HOST, SMTP_USER, SMTP_PASS in .env (see docs/email.md).");
      await new EmailNotifier(config.email).send({
        to: args[0],
        subject: "The Liwan · test email",
        text: "☕ The Liwan · test email\n\nIf you can read this, the 9pm summary and Sunday report will reach you by email.",
      });
      return console.log(`Test email sent to ${args[0]}.`);
    }
    case "serve": {
      const { serve } = await import("@hono/node-server");
      const { createApp } = await import("./web/server.js");
      serve({ fetch: createApp(db).fetch, port: config.port });
      console.log(`Dashboard: http://localhost:${config.port}`);
      if (!values["no-scheduler"]) (await import("./scheduler.js")).startScheduler(db);
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
