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
import { cashForecast, pnlRange, vatPosition } from "./domain/finance.js";
import { approveAndExecute, decideAction, listActions, markPurchaseOrderSent, receivePurchaseOrder } from "./domain/approvals.js";
import { getPurchaseOrder, listPurchaseOrders, planFromDb, poNumber, proposePurchaseOrders } from "./domain/purchasing.js";
import { FoodicsCsvSource } from "./importers/foodics-csv.js";
import { ingestSales } from "./importers/ingest.js";
import { buildDailyReport, buildWeeklyReport, renderDailyText, renderWeeklyText } from "./reports/reports.js";
import { notifyApprovalsNeeded, sendDailySummary, sendWeeklyReport } from "./reports/summary.js";
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

  Purchasing & approvals
  reorder [--dry-run] [--no-notify]  Draft purchase orders for anything at its reorder point (waits for approval).
  approvals                          What's waiting for an owner's approval.
  approve <id> --owner N             Approve (any one owner) — the order is then emailed to the supplier.
  reject <id> --owner N [--note …]
  orders [--status sent]             Purchase orders.   order <po>   Show one, with the supplier message.
  sent <po>                          Mark an order you sent yourself (WhatsApp/phone) as sent.
  received <po>                      Delivery arrived: book it into stock at the order's prices.
  suppliers                          Supplier contacts and terms.
  supplier --name N [--email] [--whatsapp] [--contact] [--lead-days] [--min-order AED]

  Finance
  vat                                VAT position for the current quarter.
  forecast                           13-week cash-flow forecast.
  cash --balance AED [--date D]      Record today's bank + till balance for the forecast.

Ingredient codes: run "stock" to list them. Dates: YYYY-MM-DD.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    reset: { type: "boolean" }, empty: { type: "boolean" }, through: { type: "string" }, "sample-date": { type: "string" },
    date: { type: "string" }, from: { type: "string" }, to: { type: "string" },
    weekly: { type: "boolean" }, send: { type: "boolean" }, "no-agent": { type: "boolean" }, lang: { type: "string" },
    verbose: { type: "boolean" }, reason: { type: "string" }, note: { type: "string" },
    name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, "preview-email": { type: "string" }, pin: { type: "string" }, locale: { type: "string" }, rename: { type: "string" },
    "no-scheduler": { type: "boolean" }, "dry-run": { type: "boolean" }, "no-notify": { type: "boolean" }, owner: { type: "string" },
    status: { type: "string" }, whatsapp: { type: "string" }, contact: { type: "string" }, "lead-days": { type: "string" }, "min-order": { type: "string" }, balance: { type: "string" }, help: { type: "boolean", short: "h" },
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
    case "reorder": {
      const date = defaultDate(db);
      if (values["dry-run"]) {
        const plan = planFromDb(db, date);
        if (!plan.length) return console.log("Nothing needs ordering (or it's already on an open order).");
        for (const o of plan) {
          console.log(`\n${o.supplierName}: AED ${(o.totalFils / 100).toFixed(2)} + VAT ${(o.vatFils / 100).toFixed(2)}${o.belowMinimum ? `  ⚠ below minimum AED ${o.minOrderFils / 100}` : ""}`);
          for (const l of o.lines) console.log(`  ${String(l.packs).padStart(3)} × ${l.packDescription.padEnd(32)} ${l.reason}`);
        }
        return console.log("\n(dry run — nothing created)");
      }
      const created = proposePurchaseOrders(db, date, "owner-cli");
      if (!created.length) return console.log("Nothing needs ordering (or it's already on an open order).");
      for (const c of created) console.log(`#${c.actionId}  ${poNumber(c.poId)} · ${c.order.supplierName}: AED ${((c.order.totalFils + c.order.vatFils) / 100).toFixed(2)} incl. VAT${c.order.belowMinimum ? " ⚠ below minimum" : ""}`);
      if (!values["no-notify"]) {
        const r = await notifyApprovalsNeeded(db, created);
        console.log(`Owners notified (${r.sent} message(s)).`);
      }
      return console.log(`Waiting for approval: npm run liwan -- approve <#> --owner "<name>"  (or in the dashboard → Approvals)`);
    }
    case "approvals": {
      const pending = listActions(db, ["pending_approval"]);
      if (!pending.length) console.log("Nothing waiting for approval.");
      for (const a of pending) {
        console.log(`#${a.id}  ${a.summary}`);
        if (a.type === "send_purchase_order") {
          const po = getPurchaseOrder(db, a.payload.poId)!;
          for (const l of po.lines) console.log(`       ${l.packs} × ${l.packDescription} — ${l.reason ?? ""}`);
          if (po.note) console.log(`       ⚠ ${po.note}`);
        }
      }
      const recent = listActions(db, ["approved", "rejected", "executed", "failed"], 5);
      if (recent.length) console.log(`\nRecent decisions:\n${recent.map((a) => `#${a.id}  ${a.status.padEnd(8)} by ${a.decidedBy ?? "—"} · ${a.summary.split(" · ")[0]}${a.result ? ` — ${a.result}` : ""}`).join("\n")}`);
      return;
    }
    case "approve":
    case "reject": {
      const id = Number(args[0]);
      if (!id || !values.owner) throw new Error(`Usage: ${cmd} <id> --owner "<owner name>"`);
      const owner = db.prepare("SELECT id, name FROM owners WHERE name = ?").get(values.owner) as any;
      if (!owner) throw new Error(`No owner named "${values.owner}". Run: npm run liwan -- owners`);
      if (cmd === "reject") {
        decideAction(db, id, owner.id, "reject", values.note);
        return console.log(`#${id} rejected by ${owner.name}. Nothing was sent.`);
      }
      const a = await approveAndExecute(db, id, owner.id);
      console.log(`#${id} approved by ${owner.name}: ${a.result}`);
      if (a.status === "failed") process.exitCode = 1;
      if (a.type === "send_purchase_order" && a.result?.includes("yourself")) {
        console.log(`\n${getPurchaseOrder(db, a.payload.poId)!.message}\n\nAfter sending: npm run liwan -- sent ${a.payload.poId}`);
      }
      return;
    }
    case "orders": {
      const list = listPurchaseOrders(db, values.status ? [values.status] : undefined, 30);
      if (!list.length) return console.log("No purchase orders yet.");
      for (const po of list) console.log(`${po.number}  ${po.status.padEnd(16)} ${po.supplier.padEnd(9)} AED ${((po.totalFils + po.vatFils) / 100).toFixed(2).padStart(9)}  ${po.expectedAt ? `expected ${po.expectedAt}` : ""}${po.receivedAt ? ` received ${po.receivedAt.slice(0, 10)}` : ""}`);
      return;
    }
    case "order": {
      const po = getPurchaseOrder(db, Number(args[0]));
      if (!po) throw new Error("Usage: order <po number, e.g. 3>");
      console.log(`${po.number} · ${po.supplier} · ${po.status}${po.sentVia ? ` (via ${po.sentVia})` : ""}`);
      for (const l of po.lines) console.log(`  ${l.packs} × ${l.packDescription} @ AED ${(l.priceFils / 100).toFixed(2)}${l.receivedPacks !== null ? ` · received ${l.receivedPacks}` : ""}`);
      console.log(`  Total AED ${(po.totalFils / 100).toFixed(2)} + VAT ${(po.vatFils / 100).toFixed(2)}`);
      if (po.message) console.log(`\n${po.message}`);
      return;
    }
    case "sent": {
      markPurchaseOrderSent(db, Number(args[0]));
      return console.log(`${poNumber(Number(args[0]))} marked as sent.`);
    }
    case "received": {
      const r = receivePurchaseOrder(db, Number(args[0]), nowIso());
      return console.log(`${poNumber(Number(args[0]))} received: ${r.lines} line(s) booked into stock, AED ${(r.totalFils / 100).toFixed(2)} + VAT ${(r.vatFils / 100).toFixed(2)}.`);
    }
    case "suppliers": {
      for (const sp of db.prepare("SELECT name, contact_name, email, whatsapp, lead_time_days, min_order_fils FROM suppliers ORDER BY name").all() as any[]) {
        console.log(`${sp.name.padEnd(10)} email: ${(sp.email ?? "—").padEnd(28)} whatsapp: ${(sp.whatsapp ?? "—").padEnd(15)} lead ${sp.lead_time_days}d · min AED ${sp.min_order_fils / 100}${sp.contact_name ? ` · ${sp.contact_name}` : ""}`);
      }
      return;
    }
    case "supplier": {
      if (!values.name) throw new Error("Usage: supplier --name Biru [--email orders@biru.ae] [--whatsapp +971…] [--contact Name] [--lead-days 1] [--min-order 150]");
      if (!db.prepare("SELECT 1 FROM suppliers WHERE name = ?").get(values.name)) throw new Error(`No supplier named "${values.name}".`);
      if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) throw new Error(`Not an email address: ${values.email}`);
      const set = (col: string, v: unknown) => db.prepare(`UPDATE suppliers SET ${col} = ? WHERE name = ?`).run(v, values.name);
      if (values.email) set("email", values.email);
      if (values.whatsapp) set("whatsapp", values.whatsapp);
      if (values.contact) set("contact_name", values.contact);
      if (values["lead-days"]) set("lead_time_days", Number(values["lead-days"]));
      if (values["min-order"]) set("min_order_fils", Math.round(Number(values["min-order"]) * 100));
      return console.log(`Updated ${values.name}.`);
    }
    case "vat": {
      const v = vatPosition(db, defaultDate(db));
      console.log(`VAT ${v.quarter.start} → ${v.quarter.end} (as of ${v.asOf}), return due ${v.quarter.due}`);
      console.log(`  Output VAT on sales       ${aed(v.outputVatFils).padStart(12)}`);
      console.log(`  Input VAT on deliveries  -${aed(v.inputVatFils).padStart(12)}`);
      console.log(`  Net payable so far        ${aed(v.netPayableFils).padStart(12)}`);
      console.log(`  Projected at quarter end  ${aed(v.projectedNetPayableFils).padStart(12)}\n  ${v.note}`);
      return;
    }
    case "forecast": {
      const f = cashForecast(db, defaultDate(db));
      console.log(`Cash forecast${f.openingKnown ? ` from ${aed(f.openingFils)} (${f.openingDate})` : " — change from today (no opening balance set)"}\n`);
      console.log("week of       takings   restock    rent  monthly    VAT      net    balance");
      for (const w of f.weeks) {
        console.log(`${w.weekStart}  ${[w.takingsFils, w.purchasesFils, w.rentFils, w.fixedCostsFils, w.vatPaidFils, w.netFils, w.closingFils].map((x) => String(Math.round(x / 100)).padStart(8)).join(" ")}`);
      }
      console.log(`\nLowest: ${aed(f.lowestFils)} in the week of ${f.lowestWeek}\n${f.assumptions.map((a) => `· ${a}`).join("\n")}`);
      return;
    }
    case "cash": {
      if (values.balance === undefined || !Number.isFinite(Number(values.balance))) throw new Error("Usage: cash --balance 25000 [--date YYYY-MM-DD]");
      const upsert = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      upsert.run("cash_balance_fils", String(Math.round(Number(values.balance) * 100)));
      upsert.run("cash_balance_date", values.date ?? todayInDubai());
      return console.log(`Cash balance recorded: ${formatAed(Math.round(Number(values.balance) * 100))} on ${values.date ?? todayInDubai()}.`);
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
