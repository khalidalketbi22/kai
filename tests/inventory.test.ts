import { describe, expect, it } from "vitest";
import { expiryAlerts, ingredientIdByCode, recordCount, recordWaste, stockStatus, writeOffExpired, consume } from "../src/domain/inventory.js";
import { pnlRange, paybackStatus } from "../src/domain/finance.js";
import { parseFoodicsCsv } from "../src/importers/foodics-csv.js";
import { ingestSales } from "../src/importers/ingest.js";
import { freshDb, H, receive, stock } from "./helpers.js";

describe("stock ledger", () => {
  it("costs consumption FEFO across lots at each lot's price", () => {
    const db = freshDb();
    const milk = ingredientIdByCode(db, "milk_fresh");
    receive(db, "milk_fresh", 2000, 0.6, "2026-10-30T07:00:00", "2026-11-05");
    receive(db, "milk_fresh", 2000, 0.7, "2026-10-31T07:00:00", "2026-11-07");
    const r = consume(db, milk, 2500, "sale", "2026-11-01T10:00:00");
    expect(r.cost).toBeCloseTo(2000 * 0.6 + 500 * 0.7);
    expect(stock(db, "milk_fresh")).toBe(1500);
  });

  it("does not sell from expired lots or lots received after the sale", () => {
    const db = freshDb();
    const milk = ingredientIdByCode(db, "milk_fresh");
    receive(db, "milk_fresh", 1000, 0.6, "2026-10-20T07:00:00", "2026-10-27"); // expired by 1 Nov
    receive(db, "milk_fresh", 1000, 0.7, "2026-11-01T15:00:00", "2026-11-08"); // arrives after the 10:00 sale
    const r = consume(db, milk, 200, "sale", "2026-11-01T10:00:00");
    expect(r.shortfall).toBe(200);
    expect(r.cost).toBeCloseTo(200 * 0.7); // shortfall costed at the latest price
  });

  it("writes off expired lots as waste and alerts on lots about to expire", () => {
    const db = freshDb();
    receive(db, "milk_fresh", 1000, 0.6, "2026-10-20T07:00:00", "2026-10-31");
    receive(db, "milk_fresh", 2000, 0.6, "2026-10-29T07:00:00", "2026-11-02");
    receive(db, "milk_fresh", 2000, 0.6, "2026-11-01T07:00:00", "2026-11-08");
    const alerts = expiryAlerts(db, "2026-11-01"); // warning window: 2 days
    expect(alerts.map((a) => [a.expiresAt, a.expired])).toEqual([["2026-10-31", true], ["2026-11-02", false]]);
    const w = writeOffExpired(db, "2026-11-01");
    expect(w).toEqual({ lots: 1, cost: 600 });
    expect(stock(db, "milk_fresh")).toBe(4000);
    expect(pnlRange(db, "2026-11-01", "2026-11-01").totals.wasteFils).toBe(600);
  });

  it("waste and staff drinks reduce stock and show in P&L waste", () => {
    const db = freshDb();
    receive(db, "beans_espresso", 1000, 15, "2026-10-31T07:00:00");
    recordWaste(db, "beans_espresso", 36, "2026-11-01T22:00:00", "dial-in");
    recordWaste(db, "beans_espresso", 18, "2026-11-01T22:00:00", "barista drink", "staff_drink");
    expect(stock(db, "beans_espresso")).toBe(946);
    expect(pnlRange(db, "2026-11-01", "2026-11-01").totals.wasteFils).toBe(54 * 15);
  });

  it("a physical count books the difference both ways", () => {
    const db = freshDb();
    receive(db, "cup_12oz", 100, 0.5, "2026-10-31T07:00:00");
    expect(recordCount(db, "cup_12oz", 90, "2026-11-01T22:00:00").diff).toBe(-10);
    expect(stock(db, "cup_12oz")).toBe(90);
    expect(recordCount(db, "cup_12oz", 95, "2026-11-01T22:30:00").diff).toBe(5);
    expect(stock(db, "cup_12oz")).toBe(95);
    const reasons = db.prepare("SELECT reason, SUM(qty) q FROM stock_movements GROUP BY reason ORDER BY reason").all();
    expect(reasons).toEqual([{ reason: "count_adjust", q: -5 }, { reason: "receive", q: 100 }]);
  });

  it("stock status: low at/below reorder point, out at zero, days of cover from 7-day usage", () => {
    const db = freshDb(); // beans_espresso reorder point 4000 g
    receive(db, "beans_espresso", 5000, 15, "2026-10-25T07:00:00");
    const csvRows = [H];
    for (let d = 26; d <= 31; d++) for (let i = 0; i < 10; i++) csvRows.push(`D${d}-${i},2026-10-${d},2026-10-${d} 12:00:00,Closed,Takeaway,LW-ESP,Espresso,,1,16,0,16,Card`);
    ingestSales(db, parseFoodicsCsv(csvRows.join("\n")));
    const beans = stockStatus(db, "2026-11-01").find((s) => s.code === "beans_espresso")!;
    expect(beans.onHand).toBe(5000 - 60 * 18); // 3920
    expect(beans.state).toBe("low");
    expect(beans.avgDailyUsage).toBeCloseTo((60 * 18) / 7, 1); // 6 trading days in the 7-day window
    expect(beans.daysOfCover).toBeCloseTo(3920 / ((60 * 18) / 7), 0);
    expect(stockStatus(db, "2026-11-01").find((s) => s.code === "saffron")!.state).toBe("out");
  });
});

describe("P&L from the database", () => {
  it("matches the hand calculation for an imported day", () => {
    const db = freshDb();
    // One AED 105.00 order (VAT 5.00, net 100.00): 3 Spanish lattes at 35 — no stock, COGS costed at standard cost
    ingestSales(db, parseFoodicsCsv([H, "P1,2026-11-01,2026-11-01 12:00:00,Closed,Takeaway,LW-SPL,Spanish Latte,,3,35,0,105,Card"].join("\n")));
    const { days, totals } = pnlRange(db, "2026-11-01", "2026-11-01");
    expect(totals.netSalesFils).toBe(10_000);
    expect(totals.vatCollectedFils).toBe(500);
    expect(days[0].rentFils).toBe(1_500); // 15% of AED 100
    const cogs = (db.prepare("SELECT cogs_fils FROM order_lines").get() as any).cogs_fils;
    expect(totals.cogsFils).toBe(cogs);
    // Seed fixed costs (14,000 + 2,500 + 800 + 400 a month) over the 31-day business month, index 24
    const share = (m: number) => Math.round((m * 25) / 31) - Math.round((m * 24) / 31);
    const fixed = share(1_400_000) + share(250_000) + share(80_000) + share(40_000);
    expect(totals.fixedCostsFils).toBe(fixed);
    expect(totals.operatingProfitFils).toBe(10_000 - cogs - 1_500 - fixed);
  });

  it("payback uses all four owners' capital (AED 160,000)", () => {
    const db = freshDb();
    expect(paybackStatus(db, "2026-11-01").capitalFils).toBe(16_000_000);
  });
});
