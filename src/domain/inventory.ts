/**
 * Inventory service — applies the pure depletion maths to the database.
 * Stock on hand = SUM(stock_movements.qty). Lots carry remaining quantity and unit cost for COGS + expiry.
 */
import type { DB } from "../db/index.js";
import { getNumberSetting } from "../db/index.js";
import {
  allocateFefo,
  requirementsForLine,
  type Lot,
  type ModifierEffect,
  type RecipeComponent,
  type SaleLine,
} from "./depletion.js";
import { addDays, type ISODate } from "./periods.js";

export interface RecipeBook {
  recipes: Map<number, RecipeComponent[]>;
  modifiers: Map<string, ModifierEffect[]>;
}

export function loadRecipeBook(db: DB): RecipeBook {
  const recipes = new Map<number, RecipeComponent[]>();
  for (const r of db.prepare("SELECT menu_item_id, ingredient_id, qty FROM recipes").all() as any[]) {
    const list = recipes.get(r.menu_item_id) ?? [];
    list.push({ ingredientId: r.ingredient_id, qty: r.qty });
    recipes.set(r.menu_item_id, list);
  }
  const modifiers = new Map<string, ModifierEffect[]>();
  const rows = db
    .prepare(
      `SELECT m.code, e.kind, e.ingredient_id, e.qty, e.to_ingredient_id, e.ratio
       FROM modifier_effects e JOIN modifiers m ON m.id = e.modifier_id`,
    )
    .all() as any[];
  for (const r of rows) {
    const list = modifiers.get(r.code) ?? [];
    list.push(
      r.kind === "add"
        ? { kind: "add", ingredientId: r.ingredient_id, qty: r.qty }
        : { kind: "swap", ingredientId: r.ingredient_id, toIngredientId: r.to_ingredient_id, ratio: r.ratio },
    );
    modifiers.set(r.code, list);
  }
  return { recipes, modifiers };
}

export function ingredientIdByCode(db: DB, code: string): number {
  const row = db.prepare("SELECT id FROM ingredients WHERE code = ?").get(code) as { id: number } | undefined;
  if (!row) throw new Error(`Unknown ingredient code: ${code}`);
  return row.id;
}

/** Lots usable at time `at`: already received, not yet expired, with stock left. */
export function usableLots(db: DB, ingredientId: number, at: string): Lot[] {
  const day = at.slice(0, 10);
  return (
    db
      .prepare(
        `SELECT id, qty_remaining, unit_cost, received_at, expires_at FROM stock_lots
         WHERE ingredient_id = ? AND qty_remaining > 0 AND received_at <= ?
           AND (expires_at IS NULL OR expires_at >= ?)`,
      )
      .all(ingredientId, at, day) as any[]
  ).map((r) => ({ id: r.id, qtyRemaining: r.qty_remaining, unitCost: r.unit_cost, receivedAt: r.received_at, expiresAt: r.expires_at }));
}

/** Most recent purchase cost, falling back to the ingredient's standard cost. */
export function currentUnitCost(db: DB, ingredientId: number): number {
  const lot = db
    .prepare("SELECT unit_cost FROM stock_lots WHERE ingredient_id = ? ORDER BY received_at DESC, id DESC LIMIT 1")
    .get(ingredientId) as { unit_cost: number } | undefined;
  if (lot) return lot.unit_cost;
  const ing = db.prepare("SELECT std_unit_cost FROM ingredients WHERE id = ?").get(ingredientId) as { std_unit_cost: number };
  return ing.std_unit_cost;
}

export interface ReceiveInput {
  ingredientId: number;
  qty: number;
  unitCost: number; // fils per base unit, ex-VAT
  receivedAt: string;
  expiresAt?: string | null;
  supplierId?: number | null;
  poId?: number | null;
  reason?: "receive" | "count_adjust";
  note?: string | null;
}

export function receiveStock(db: DB, r: ReceiveInput): number {
  let expires = r.expiresAt;
  if (expires === undefined) {
    const ing = db.prepare("SELECT shelf_life_days FROM ingredients WHERE id = ?").get(r.ingredientId) as { shelf_life_days: number | null };
    expires = ing.shelf_life_days ? addDays(r.receivedAt.slice(0, 10), ing.shelf_life_days) : null;
  }
  const lot = db
    .prepare(
      `INSERT INTO stock_lots (ingredient_id, qty_received, qty_remaining, unit_cost, received_at, expires_at, supplier_id, po_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.ingredientId, r.qty, r.qty, r.unitCost, r.receivedAt, expires, r.supplierId ?? null, r.poId ?? null);
  const lotId = Number(lot.lastInsertRowid);
  db.prepare(
    `INSERT INTO stock_movements (ingredient_id, lot_id, qty, cost_fils, reason, ref, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.ingredientId, lotId, r.qty, r.qty * r.unitCost, r.reason ?? "receive", r.poId ? `po:${r.poId}` : null, r.note ?? null, r.receivedAt);
  return lotId;
}

export type ConsumeReason = "sale" | "waste" | "count_adjust" | "staff_drink" | "sample";

/** Remove stock (FEFO), writing one movement per lot touched. Returns cost in fils (unrounded) and any shortfall. */
export function consume(
  db: DB,
  ingredientId: number,
  qty: number,
  reason: ConsumeReason,
  at: string,
  ref: string | null = null,
  note: string | null = null,
): { cost: number; shortfall: number } {
  if (qty <= 0) return { cost: 0, shortfall: 0 };
  const result = allocateFefo(usableLots(db, ingredientId, at), qty, currentUnitCost(db, ingredientId));
  const upd = db.prepare("UPDATE stock_lots SET qty_remaining = qty_remaining - ? WHERE id = ?");
  const mov = db.prepare(
    `INSERT INTO stock_movements (ingredient_id, lot_id, qty, cost_fils, reason, ref, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of result.allocations) {
    if (a.lotId !== null) upd.run(a.qty, a.lotId);
    mov.run(ingredientId, a.lotId, -a.qty, -a.cost, reason, ref, a.lotId === null ? "shortfall: not enough stock on record" : note, at);
  }
  return { cost: result.totalCost, shortfall: result.shortfall };
}

/** Deplete stock for one imported POS line and store its COGS. */
export function depleteOrderLine(db: DB, book: RecipeBook, lineId: number, line: SaleLine, at: string): { cogsFils: number; shortfalls: number[] } {
  const req = requirementsForLine(line, book.recipes, book.modifiers);
  let cost = 0;
  const shortfalls: number[] = [];
  for (const [ingredientId, qty] of req) {
    const r = consume(db, ingredientId, qty, "sale", at, `order_line:${lineId}`);
    cost += r.cost;
    if (r.shortfall > 0) shortfalls.push(ingredientId);
  }
  const cogsFils = Math.round(cost);
  db.prepare("UPDATE order_lines SET cogs_fils = ? WHERE id = ?").run(cogsFils, lineId);
  return { cogsFils, shortfalls };
}

export function recordWaste(db: DB, ingredientCode: string, qty: number, at: string, note: string, reason: "waste" | "staff_drink" | "sample" = "waste") {
  return consume(db, ingredientIdByCode(db, ingredientCode), qty, reason, at, null, note);
}

/** Write off whatever is left in expired lots (qty_remaining > 0, expires_at < today). */
export function writeOffExpired(db: DB, today: ISODate): { lots: number; cost: number } {
  const lots = db
    .prepare("SELECT id, ingredient_id, qty_remaining, unit_cost FROM stock_lots WHERE qty_remaining > 0 AND expires_at IS NOT NULL AND expires_at < ?")
    .all(today) as any[];
  let cost = 0;
  const tx = db.transaction(() => {
    for (const l of lots) {
      db.prepare("UPDATE stock_lots SET qty_remaining = 0 WHERE id = ?").run(l.id);
      db.prepare(
        `INSERT INTO stock_movements (ingredient_id, lot_id, qty, cost_fils, reason, note, at) VALUES (?, ?, ?, ?, 'waste', 'expired', ?)`,
      ).run(l.ingredient_id, l.id, -l.qty_remaining, -l.qty_remaining * l.unit_cost, `${today}T00:00:00`);
      cost += l.qty_remaining * l.unit_cost;
    }
  });
  tx();
  return { lots: lots.length, cost };
}

/** Physical stock count: book the difference as a count adjustment. */
export function recordCount(db: DB, ingredientCode: string, countedQty: number, at: string): { diff: number } {
  const id = ingredientIdByCode(db, ingredientCode);
  const diff = countedQty - onHand(db, id);
  if (diff < 0) consume(db, id, -diff, "count_adjust", at, null, `count ${countedQty}`);
  if (diff > 0) {
    receiveStock(db, { ingredientId: id, qty: diff, unitCost: currentUnitCost(db, id), receivedAt: at, reason: "count_adjust", note: `count ${countedQty}` });
  }
  return { diff };
}

export function onHand(db: DB, ingredientId: number): number {
  const r = db.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_movements WHERE ingredient_id = ?").get(ingredientId) as { q: number };
  return Math.round(r.q * 1e6) / 1e6;
}

export type StockState = "ok" | "low" | "out";

export interface StockRow {
  ingredientId: number;
  code: string;
  nameEn: string;
  nameAr: string;
  unit: string;
  onHand: number;
  reorderPoint: number;
  parLevel: number;
  avgDailyUsage: number; // last 7 days, sales + staff drinks + samples
  daysOfCover: number | null;
  state: StockState;
  nextExpiry: string | null;
  valueFils: number;
  supplier: string | null;
}

export function stockStatus(db: DB, asOf: ISODate): StockRow[] {
  const from = addDays(asOf, -6);
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name_en, i.name_ar, i.unit, i.reorder_point, i.par_level, s.name AS supplier,
         (SELECT COALESCE(SUM(qty),0) FROM stock_movements m WHERE m.ingredient_id = i.id) AS on_hand,
         (SELECT COALESCE(-SUM(qty),0) FROM stock_movements m WHERE m.ingredient_id = i.id
            AND m.reason IN ('sale','staff_drink','sample') AND substr(m.at,1,10) BETWEEN ? AND ?) AS used7,
         (SELECT MIN(expires_at) FROM stock_lots l WHERE l.ingredient_id = i.id AND l.qty_remaining > 0) AS next_expiry,
         (SELECT COALESCE(SUM(qty_remaining * unit_cost),0) FROM stock_lots l WHERE l.ingredient_id = i.id AND l.qty_remaining > 0) AS value
       FROM ingredients i LEFT JOIN suppliers s ON s.id = i.default_supplier_id
       ORDER BY i.name_en`,
    )
    .all(from, asOf) as any[];
  return rows.map((r) => {
    const onHandQ = Math.round(r.on_hand * 1000) / 1000;
    const avg = r.used7 / 7;
    const state: StockState = onHandQ <= 0 ? "out" : onHandQ <= r.reorder_point ? "low" : "ok";
    return {
      ingredientId: r.id,
      code: r.code,
      nameEn: r.name_en,
      nameAr: r.name_ar,
      unit: r.unit,
      onHand: onHandQ,
      reorderPoint: r.reorder_point,
      parLevel: r.par_level,
      avgDailyUsage: Math.round(avg * 100) / 100,
      daysOfCover: avg > 0 ? Math.round((Math.max(0, onHandQ) / avg) * 10) / 10 : null,
      state,
      nextExpiry: r.next_expiry,
      valueFils: Math.round(r.value),
      supplier: r.supplier,
    };
  });
}

export interface ExpiryAlert {
  lotId: number;
  code: string;
  nameEn: string;
  nameAr: string;
  unit: string;
  qtyRemaining: number;
  expiresAt: string;
  expired: boolean;
}

export function expiryAlerts(db: DB, today: ISODate): ExpiryAlert[] {
  const warn = getNumberSetting(db, "expiry_warning_days");
  return (
    db
      .prepare(
        `SELECT l.id, i.code, i.name_en, i.name_ar, i.unit, l.qty_remaining, l.expires_at FROM stock_lots l
         JOIN ingredients i ON i.id = l.ingredient_id
         WHERE l.qty_remaining > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ?
         ORDER BY l.expires_at`,
      )
      .all(addDays(today, warn)) as any[]
  ).map((r) => ({
    lotId: r.id,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    unit: r.unit,
    qtyRemaining: Math.round(r.qty_remaining * 100) / 100,
    expiresAt: r.expires_at,
    expired: r.expires_at < today,
  }));
}

/** Sale movements that couldn't be matched to stock on record — a sign a count or delivery is missing. */
export function shortfalls(db: DB, from: ISODate, to: ISODate): { code: string; nameEn: string; nameAr: string; unit: string; qty: number }[] {
  return (
    db
      .prepare(
        `SELECT i.code, i.name_en, i.name_ar, i.unit, -SUM(m.qty) AS qty FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id
         WHERE m.lot_id IS NULL AND m.qty < 0 AND substr(m.at,1,10) BETWEEN ? AND ? GROUP BY i.id ORDER BY qty DESC`,
      )
      .all(from, to) as any[]
  ).map((r) => ({ code: r.code, nameEn: r.name_en, nameAr: r.name_ar, unit: r.unit, qty: Math.round(r.qty * 100) / 100 }));
}
