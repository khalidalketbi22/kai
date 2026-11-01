/**
 * Purchasing — when to reorder, how much, from whom.
 *
 *   planPurchaseOrders()      pure: stock + usage + supplier terms → proposed orders per supplier
 *   proposePurchaseOrders()   DB: writes them as purchase orders awaiting an owner's approval (never sends)
 *
 * Rules
 *   • Trigger: stock expected at delivery time (on hand − daily usage × lead time) is at/below the reorder point.
 *   • Quantity: enough to be back at par level when the delivery arrives, rounded UP to whole supplier packs.
 *   • Perishables: never order more than ~80% of what you can use before it expires.
 *   • Minimum order: if a supplier's order is under its minimum, top up other items from that supplier that are
 *     below par (lowest days of cover first). If it's still under, the order is flagged for the owners to decide.
 *   • Ingredients already on an open order (awaiting approval, approved or sent) are skipped.
 */
import type { DB } from "../db/index.js";
import { getNumberSetting } from "../db/index.js";
import { addDays, type ISODate } from "./periods.js";
import { stockStatus } from "./inventory.js";

export interface PlanItem {
  ingredientId: number;
  code: string;
  name: string;
  unit: string;
  onHand: number;
  reorderPoint: number;
  parLevel: number;
  avgDailyUsage: number;
  shelfLifeDays: number | null;
  supplierId: number;
  supplierProductId: number;
  packQty: number;
  packPriceFils: number; // ex-VAT
  packDescription: string;
  sku: string | null;
}

export interface SupplierTerms { id: number; name: string; leadTimeDays: number; minOrderFils: number }

export interface ProposedLine {
  ingredientId: number;
  supplierProductId: number;
  name: string;
  packDescription: string;
  sku: string | null;
  packs: number;
  qty: number;           // base units
  packPriceFils: number;
  lineFils: number;      // ex-VAT
  reason: string;
}

export interface ProposedOrder {
  supplierId: number;
  supplierName: string;
  leadTimeDays: number;
  lines: ProposedLine[];
  totalFils: number;     // ex-VAT
  vatFils: number;
  minOrderFils: number;
  belowMinimum: boolean;
}

const SHELF_LIFE_USE_RATIO = 0.8;

const fmtQty = (q: number, unit: string) =>
  unit === "pc" ? `${Math.round(q)} pcs` : q >= 1000 ? `${(q / 1000).toFixed(1)} ${unit === "g" ? "kg" : "L"}` : `${Math.round(q)} ${unit}`;

/** Packs needed to bring `item` back to par by the time a delivery arrives (0 if not needed). */
export function packsToPar(item: PlanItem, leadTimeDays: number): number {
  const atDelivery = Math.max(0, item.onHand) - item.avgDailyUsage * leadTimeDays;
  const need = item.parLevel - Math.max(0, atDelivery);
  if (need <= 0) return 0;
  let packs = Math.ceil(need / item.packQty - 1e-9);
  if (item.shelfLifeDays && item.avgDailyUsage > 0) {
    const usable = item.avgDailyUsage * item.shelfLifeDays * SHELF_LIFE_USE_RATIO;
    packs = Math.min(packs, Math.max(1, Math.floor(usable / item.packQty)));
  }
  return packs;
}

export function needsReorder(item: PlanItem, leadTimeDays: number): boolean {
  const atDelivery = item.onHand - item.avgDailyUsage * leadTimeDays;
  return atDelivery <= item.reorderPoint;
}

export function planPurchaseOrders(items: PlanItem[], suppliers: SupplierTerms[], skipIngredientIds: Set<number> = new Set(), vatRate = 0.05): ProposedOrder[] {
  const orders: ProposedOrder[] = [];
  for (const s of suppliers) {
    const mine = items.filter((i) => i.supplierId === s.id && !skipIngredientIds.has(i.ingredientId));
    const lines: ProposedLine[] = [];
    const line = (i: PlanItem, packs: number, reason: string): ProposedLine => ({
      ingredientId: i.ingredientId,
      supplierProductId: i.supplierProductId,
      name: i.name,
      packDescription: i.packDescription,
      sku: i.sku,
      packs,
      qty: packs * i.packQty,
      packPriceFils: i.packPriceFils,
      lineFils: packs * i.packPriceFils,
      reason,
    });

    for (const i of mine) {
      if (!needsReorder(i, s.leadTimeDays)) continue;
      const packs = Math.max(1, packsToPar(i, s.leadTimeDays));
      const cover = i.avgDailyUsage > 0 ? `${(Math.max(0, i.onHand) / i.avgDailyUsage).toFixed(1)} days cover` : "no recent usage";
      lines.push(line(i, packs, `${i.onHand <= 0 ? "out of stock" : `${fmtQty(i.onHand, i.unit)} left`} (reorder at ${fmtQty(i.reorderPoint, i.unit)}, ${cover})`));
    }
    if (lines.length === 0) continue;

    let total = lines.reduce((t, l) => t + l.lineFils, 0);
    if (total < s.minOrderFils) {
      const cover = (i: PlanItem) => (i.avgDailyUsage > 0 ? i.onHand / i.avgDailyUsage : Infinity);
      const candidates = mine
        .filter((i) => !lines.some((l) => l.ingredientId === i.ingredientId) && i.onHand < i.parLevel)
        .sort((a, b) => cover(a) - cover(b));
      for (const i of candidates) {
        if (total >= s.minOrderFils) break;
        const packs = packsToPar(i, s.leadTimeDays);
        if (packs <= 0) continue;
        lines.push(line(i, packs, `top-up to reach ${s.name}'s minimum order`));
        total += packs * i.packPriceFils;
      }
    }

    orders.push({
      supplierId: s.id,
      supplierName: s.name,
      leadTimeDays: s.leadTimeDays,
      lines,
      totalFils: total,
      vatFils: Math.round(total * vatRate),
      minOrderFils: s.minOrderFils,
      belowMinimum: total < s.minOrderFils,
    });
  }
  return orders;
}

// ------------------------------------------------------------------ database

export const OPEN_PO_STATUSES = ["pending_approval", "approved", "sent"] as const;

export function openOrderIngredientIds(db: DB): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT sp.ingredient_id AS id FROM po_lines l
       JOIN purchase_orders po ON po.id = l.po_id JOIN supplier_products sp ON sp.id = l.supplier_product_id
       WHERE po.status IN ('pending_approval','approved','sent')`,
    )
    .all() as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

export function loadPlanInputs(db: DB, asOf: ISODate): { items: PlanItem[]; suppliers: SupplierTerms[] } {
  const status = new Map(stockStatus(db, asOf).map((s) => [s.ingredientId, s]));
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name_en, i.unit, i.reorder_point, i.par_level, i.shelf_life_days, i.default_supplier_id,
              p.id AS sp_id, p.pack_qty, p.price_fils, p.description, p.sku
       FROM ingredients i JOIN supplier_products p ON p.ingredient_id = i.id AND p.supplier_id = i.default_supplier_id`,
    )
    .all() as any[];
  const items: PlanItem[] = rows.map((r) => {
    const s = status.get(r.id)!;
    return {
      ingredientId: r.id, code: r.code, name: r.name_en, unit: r.unit,
      onHand: s.onHand, reorderPoint: r.reorder_point, parLevel: r.par_level, avgDailyUsage: s.avgDailyUsage,
      shelfLifeDays: r.shelf_life_days, supplierId: r.default_supplier_id, supplierProductId: r.sp_id,
      packQty: r.pack_qty, packPriceFils: r.price_fils, packDescription: r.description, sku: r.sku,
    };
  });
  const suppliers = (db.prepare("SELECT id, name, lead_time_days, min_order_fils FROM suppliers ORDER BY name").all() as any[]).map((s) => ({
    id: s.id, name: s.name, leadTimeDays: s.lead_time_days, minOrderFils: s.min_order_fils,
  }));
  return { items, suppliers };
}

export function planFromDb(db: DB, asOf: ISODate): ProposedOrder[] {
  const { items, suppliers } = loadPlanInputs(db, asOf);
  return planPurchaseOrders(items, suppliers, openOrderIngredientIds(db), getNumberSetting(db, "vat_rate"));
}

export const poNumber = (id: number) => `LW-PO-${String(id).padStart(4, "0")}`;

export interface CreatedOrder { poId: number; actionId: number; order: ProposedOrder }

/**
 * Write proposed orders as purchase orders awaiting approval, each with an `actions` row.
 * This is the ONLY write the agents can trigger in purchasing. Nothing is sent to a supplier here.
 */
export function proposePurchaseOrders(db: DB, asOf: ISODate, proposedBy: string, now = new Date().toISOString()): CreatedOrder[] {
  const plan = planFromDb(db, asOf);
  const created: CreatedOrder[] = [];
  const tx = db.transaction(() => {
    for (const o of plan) {
      const po = db
        .prepare(`INSERT INTO purchase_orders (supplier_id, status, total_fils, vat_fils, created_at, created_by, note) VALUES (?, 'pending_approval', ?, ?, ?, ?, ?)`)
        .run(o.supplierId, o.totalFils, o.vatFils, now, proposedBy, o.belowMinimum ? `Below ${o.supplierName}'s minimum order of AED ${(o.minOrderFils / 100).toFixed(0)}` : null);
      const poId = Number(po.lastInsertRowid);
      for (const l of o.lines) {
        db.prepare("INSERT INTO po_lines (po_id, supplier_product_id, packs, price_fils, reason) VALUES (?, ?, ?, ?, ?)").run(poId, l.supplierProductId, l.packs, l.packPriceFils, l.reason);
      }
      const summary = `${poNumber(poId)} · ${o.supplierName}: ${o.lines.map((l) => `${l.packs}× ${l.packDescription}`).join(", ")} — AED ${((o.totalFils + o.vatFils) / 100).toFixed(2)} incl. VAT`;
      const action = db
        .prepare(`INSERT INTO actions (type, payload, summary, amount_fils, status, proposed_by, proposed_at) VALUES ('send_purchase_order', ?, ?, ?, 'pending_approval', ?, ?)`)
        .run(JSON.stringify({ poId }), summary, o.totalFils + o.vatFils, proposedBy, now);
      const actionId = Number(action.lastInsertRowid);
      db.prepare("UPDATE purchase_orders SET action_id = ? WHERE id = ?").run(actionId, poId);
      created.push({ poId, actionId, order: o });
    }
  });
  tx();
  return created;
}

export interface PurchaseOrderView {
  id: number;
  number: string;
  supplierId: number;
  supplier: string;
  supplierEmail: string | null;
  supplierWhatsapp: string | null;
  status: string;
  totalFils: number;
  vatFils: number;
  createdAt: string;
  createdBy: string;
  note: string | null;
  message: string | null;
  sentVia: string | null;
  sentAt: string | null;
  expectedAt: string | null;
  receivedAt: string | null;
  actionId: number | null;
  lines: { id: number; ingredientId: number; name: string; packDescription: string; sku: string | null; packs: number; packQty: number; unit: string; priceFils: number; receivedPacks: number | null; reason: string | null }[];
}

export function getPurchaseOrder(db: DB, poId: number): PurchaseOrderView | null {
  const po = db
    .prepare(
      `SELECT po.*, s.name AS supplier, s.email AS supplier_email, s.whatsapp AS supplier_whatsapp FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`,
    )
    .get(poId) as any;
  if (!po) return null;
  const lines = (
    db
      .prepare(
        `SELECT l.id, sp.ingredient_id, i.name_en, sp.description, sp.sku, l.packs, sp.pack_qty, i.unit, l.price_fils, l.received_packs, l.reason
         FROM po_lines l JOIN supplier_products sp ON sp.id = l.supplier_product_id JOIN ingredients i ON i.id = sp.ingredient_id
         WHERE l.po_id = ? ORDER BY l.id`,
      )
      .all(poId) as any[]
  ).map((l) => ({
    id: l.id, ingredientId: l.ingredient_id, name: l.name_en, packDescription: l.description, sku: l.sku, packs: l.packs,
    packQty: l.pack_qty, unit: l.unit, priceFils: l.price_fils, receivedPacks: l.received_packs, reason: l.reason,
  }));
  return {
    id: po.id, number: poNumber(po.id), supplierId: po.supplier_id, supplier: po.supplier, supplierEmail: po.supplier_email,
    supplierWhatsapp: po.supplier_whatsapp, status: po.status, totalFils: po.total_fils, vatFils: po.vat_fils, createdAt: po.created_at,
    createdBy: po.created_by, note: po.note, message: po.message, sentVia: po.sent_via, sentAt: po.sent_at, expectedAt: po.expected_at,
    receivedAt: po.received_at, actionId: po.action_id, lines,
  };
}

export function listPurchaseOrders(db: DB, statuses?: string[], limit = 50): PurchaseOrderView[] {
  const where = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
  const ids = db.prepare(`SELECT id FROM purchase_orders ${where} ORDER BY id DESC LIMIT ?`).all(...(statuses ?? []), limit) as { id: number }[];
  return ids.map((r) => getPurchaseOrder(db, r.id)!);
}

/** The message a supplier receives for an approved order. */
export function composePurchaseOrderMessage(po: PurchaseOrderView, deliverTo: string, deliverBy: ISODate): { subject: string; text: string } {
  const lines = po.lines.map((l) => `• ${l.packs} × ${l.packDescription}${l.sku ? ` (${l.sku})` : ""} @ AED ${(l.priceFils / 100).toFixed(2)}`);
  return {
    subject: `Purchase order ${po.number} — The Liwan`,
    text: [
      `Hello ${po.supplier} team,`,
      ``,
      `Please supply the following for The Liwan (purchase order ${po.number}):`,
      ``,
      ...lines,
      ``,
      `Total: AED ${(po.totalFils / 100).toFixed(2)} + VAT AED ${(po.vatFils / 100).toFixed(2)} = AED ${((po.totalFils + po.vatFils) / 100).toFixed(2)}`,
      `Deliver to: ${deliverTo}`,
      `Requested by: ${deliverBy}`,
      ``,
      `Please reply to confirm availability, price and delivery time, and include ${po.number} on the tax invoice.`,
      ``,
      `Thank you,`,
      `The Liwan · الليوان`,
    ].join("\n"),
  };
}

export const expectedDelivery = (sentDate: ISODate, leadTimeDays: number) => addDays(sentDate, leadTimeDays);
