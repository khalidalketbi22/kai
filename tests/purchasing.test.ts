import { describe, expect, it } from "vitest";
import { needsReorder, packsToPar, planPurchaseOrders, proposePurchaseOrders, type PlanItem, type SupplierTerms } from "../src/domain/purchasing.js";
import { freshDb, receive } from "./helpers.js";

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  ingredientId: 1, code: "milk_fresh", name: "Fresh milk", unit: "ml", onHand: 10_000, reorderPoint: 22_000, parLevel: 44_000,
  avgDailyUsage: 0, shelfLifeDays: null, supplierId: 1, supplierProductId: 11, packQty: 2_000, packPriceFils: 1_200,
  packDescription: "Fresh milk 2L", sku: "BR-MILK-2L", ...over,
});
const biru: SupplierTerms = { id: 1, name: "Biru", leadTimeDays: 1, minOrderFils: 15_000 };
const goldbox: SupplierTerms = { id: 2, name: "Goldbox", leadTimeDays: 3, minOrderFils: 25_000 };

describe("packsToPar", () => {
  it("rounds up to whole packs to reach par", () => {
    // need 44,000 − 10,000 = 34,000 ml → 17 × 2 L
    expect(packsToPar(item(), 0)).toBe(17);
    expect(packsToPar(item({ onHand: 10_500 }), 0)).toBe(17); // 33,500 → 16.75 → 17
  });
  it("accounts for what will be used before the delivery arrives", () => {
    // 10,000 − 2 days × 3,000 = 4,000 at delivery → need 40,000 → 20 packs
    expect(packsToPar(item({ avgDailyUsage: 3_000, shelfLifeDays: null }), 2)).toBe(20);
  });
  it("never orders more perishable stock than can be used before it expires (80%)", () => {
    // 3,000 ml/day × 7 days × 0.8 = 16,800 ml → 8 packs, even though par needs 20
    expect(packsToPar(item({ avgDailyUsage: 3_000, shelfLifeDays: 7 }), 2)).toBe(8);
  });
  it("orders nothing when already at par", () => expect(packsToPar(item({ onHand: 50_000 }), 1)).toBe(0));
  it("treats negative stock (shortfall) as zero", () => expect(packsToPar(item({ onHand: -700 }), 0)).toBe(22));
});

describe("needsReorder", () => {
  it("triggers at or below the reorder point", () => {
    expect(needsReorder(item({ onHand: 22_000 }), 0)).toBe(true);
    expect(needsReorder(item({ onHand: 22_001 }), 0)).toBe(false);
  });
  it("triggers early when stock will hit the reorder point before delivery", () => {
    expect(needsReorder(item({ onHand: 30_000, avgDailyUsage: 5_000 }), 2)).toBe(true); // 20,000 at delivery
    expect(needsReorder(item({ onHand: 30_000, avgDailyUsage: 5_000 }), 1)).toBe(false); // 25,000
  });
});

describe("planPurchaseOrders", () => {
  const cups = item({ ingredientId: 2, code: "cup_12oz", name: "Cup 12oz", unit: "pc", onHand: 223, reorderPoint: 250, parLevel: 600, supplierId: 2, supplierProductId: 22, packQty: 50, packPriceFils: 2_500, packDescription: "Cup 12oz ×50" });
  const lids = item({ ingredientId: 3, code: "lid_hot", name: "Hot lid", unit: "pc", onHand: 600, reorderPoint: 300, parLevel: 800, supplierId: 2, supplierProductId: 33, packQty: 100, packPriceFils: 1_800, packDescription: "Hot lid ×100", avgDailyUsage: 70 });

  it("groups by supplier with VAT", () => {
    const plan = planPurchaseOrders([item(), cups], [biru, goldbox]);
    expect(plan.map((o) => o.supplierName)).toEqual(["Biru", "Goldbox"]);
    expect(plan[0]).toMatchObject({ totalFils: 17 * 1_200, vatFils: Math.round(17 * 1_200 * 0.05) });
    expect(plan[1].lines[0]).toMatchObject({ packs: 8, qty: 400, lineFils: 20_000 }); // 600 − 223 = 377 → 8 × 50
  });

  it("tops up below-par items to reach the supplier minimum", () => {
    const plan = planPurchaseOrders([cups, lids], [goldbox]); // cups 200.00 < 250.00 minimum
    // Hot lids aren't due (600 − 70/day × 3-day lead = 390 > 300) but are below par:
    // 800 − 390 = 410 → 5 packs of 100 tops the order up past the AED 250 minimum
    expect(plan[0].lines.map((l) => [l.name, l.packs])).toEqual([["Cup 12oz", 8], ["Hot lid", 5]]);
    expect(plan[0].lines[1].reason).toMatch(/minimum/);
    expect(plan[0].totalFils).toBe(20_000 + 9_000);
    expect(plan[0].belowMinimum).toBe(false);
  });

  it("flags orders still below the minimum", () => {
    const plan = planPurchaseOrders([cups], [{ ...goldbox, minOrderFils: 100_000 }]);
    expect(plan[0].belowMinimum).toBe(true);
  });

  it("skips ingredients already on an open order", () => {
    expect(planPurchaseOrders([item(), cups], [biru, goldbox], new Set([1])).map((o) => o.supplierName)).toEqual(["Goldbox"]);
  });

  it("returns nothing when nothing is low", () => expect(planPurchaseOrders([item({ onHand: 40_000 })], [biru])).toEqual([]));
});

describe("proposePurchaseOrders (database)", () => {
  it("creates purchase orders waiting for approval, once", () => {
    const db = freshDb(); // empty stock → everything is at/below reorder point
    const created = proposePurchaseOrders(db, "2026-11-01", "test");
    expect(created.map((c) => c.order.supplierName).sort()).toEqual(["Biru", "Goldbox", "Windmill"]);
    const statuses = db.prepare("SELECT DISTINCT status FROM purchase_orders").all();
    expect(statuses).toEqual([{ status: "pending_approval" }]);
    const actions = db.prepare("SELECT type, status, proposed_by FROM actions").all() as any[];
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.type === "send_purchase_order" && a.status === "pending_approval")).toBe(true);
    expect(proposePurchaseOrders(db, "2026-11-01", "test")).toHaveLength(0); // already on open orders
  });

  it("orders nothing for well-stocked ingredients", () => {
    const db = freshDb();
    receive(db, "beans_espresso", 12_000, 15, "2026-10-31T08:00:00");
    const windmill = proposePurchaseOrders(db, "2026-11-01", "test").find((c) => c.order.supplierName === "Windmill")!;
    expect(windmill.order.lines.map((l) => l.name)).not.toContain("House espresso beans");
  });
});
