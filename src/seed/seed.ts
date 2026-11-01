/**
 * Seed the database with reference data and a simulated trading history.
 *
 *   seedReferenceData()  menu, recipes, modifiers, ingredients, suppliers, owners, capital, fixed costs
 *   simulateHistory()    day by day from trading start: morning deliveries (to par when at/below reorder point),
 *                        that day's POS sales imported through the real importer, steaming waste, staff drinks,
 *                        expired-stock write-offs.
 */
import type { DB } from "../db/index.js";
import { aedToFils } from "../domain/money.js";
import { eachDay } from "../domain/periods.js";
import { ingredientIdByCode, onHand, receiveStock, recordWaste, writeOffExpired } from "../domain/inventory.js";
import { parseFoodicsCsv } from "../importers/foodics-csv.js";
import { ingestSales } from "../importers/ingest.js";
import { addStaff, generateWeekRota, parseRestDay, weekStartOf } from "../domain/staff.js";
import { addDays } from "../domain/periods.js";
import { DEMO_STAFF, CAPITAL_DATE, CAPITAL_PER_OWNER_AED, FIXED_COSTS, INGREDIENTS, MENU, MODIFIERS, OWNERS, SUPPLIERS } from "./data.js";
import { generateFoodicsCsv } from "./generate-sales.js";

export function seedReferenceData(db: DB): void {
  const tx = db.transaction(() => {
    const insOwner = db.prepare("INSERT INTO owners (name, locale) VALUES (?, ?)");
    const insCap = db.prepare("INSERT INTO capital_contributions (owner_id, amount_fils, date) VALUES (?, ?, ?)");
    for (const o of OWNERS) {
      const id = Number(insOwner.run(o.name, o.locale).lastInsertRowid);
      insCap.run(id, aedToFils(CAPITAL_PER_OWNER_AED), CAPITAL_DATE);
    }

    const supplierId = new Map<string, number>();
    for (const s of SUPPLIERS) {
      const r = db.prepare("INSERT INTO suppliers (name, lead_time_days, min_order_fils) VALUES (?, ?, ?)").run(s.name, s.leadTimeDays, aedToFils(s.minOrderAed));
      supplierId.set(s.name, Number(r.lastInsertRowid));
    }

    for (const i of INGREDIENTS) {
      const sid = supplierId.get(i.supplier)!;
      const unitCost = aedToFils(i.pack.priceAed) / i.pack.qty;
      const r = db
        .prepare(
          `INSERT INTO ingredients (code, name_en, name_ar, unit, reorder_point, par_level, shelf_life_days, default_supplier_id, std_unit_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(i.code, i.nameEn, i.nameAr, i.unit, i.reorderPoint, i.parLevel, i.shelfLifeDays, sid, unitCost);
      db.prepare("INSERT INTO supplier_products (supplier_id, ingredient_id, sku, description, pack_qty, price_fils) VALUES (?, ?, ?, ?, ?, ?)").run(
        sid, Number(r.lastInsertRowid), i.pack.sku, i.pack.description, i.pack.qty, aedToFils(i.pack.priceAed),
      );
    }

    for (const m of MENU) {
      const r = db
        .prepare("INSERT INTO menu_items (sku, name_en, name_ar, category, price_incl_vat_fils) VALUES (?, ?, ?, ?, ?)")
        .run(m.sku, m.nameEn, m.nameAr, m.category, aedToFils(m.priceAed));
      const mid = Number(r.lastInsertRowid);
      for (const [code, qty] of Object.entries(m.recipe)) {
        db.prepare("INSERT INTO recipes (menu_item_id, ingredient_id, qty) VALUES (?, ?, ?)").run(mid, ingredientIdByCode(db, code), qty);
      }
    }

    for (const m of MODIFIERS) {
      const r = db.prepare("INSERT INTO modifiers (code, name_en, name_ar, price_incl_vat_fils) VALUES (?, ?, ?, ?)").run(m.code, m.nameEn, m.nameAr, aedToFils(m.priceAed));
      const modId = Number(r.lastInsertRowid);
      for (const e of m.effects) {
        if (e.kind === "swap") {
          db.prepare("INSERT INTO modifier_effects (modifier_id, kind, ingredient_id, to_ingredient_id, ratio) VALUES (?, 'swap', ?, ?, ?)").run(
            modId, ingredientIdByCode(db, e.from), ingredientIdByCode(db, e.to), e.ratio,
          );
        } else {
          db.prepare("INSERT INTO modifier_effects (modifier_id, kind, ingredient_id, qty) VALUES (?, 'add', ?, ?)").run(modId, ingredientIdByCode(db, e.ingredient), e.qty);
        }
      }
    }

    for (const c of FIXED_COSTS) {
      db.prepare("INSERT INTO expenses (name, category, kind, amount_fils, start_date, end_date) VALUES (?, ?, 'fixed_monthly', ?, ?, ?)").run(
        c.name, c.category, aedToFils(c.monthlyAed), c.start, c.end,
      );
    }
  });
  tx();
}

/** Receive stock up to par for every ingredient at/below its reorder point (simulates deliveries). */
export function restockToPar(db: DB, at: string, force = false): number {
  const rows = db
    .prepare(
      `SELECT i.id, i.reorder_point, i.par_level, i.default_supplier_id, p.pack_qty, p.price_fils
       FROM ingredients i JOIN supplier_products p ON p.ingredient_id = i.id AND p.supplier_id = i.default_supplier_id`,
    )
    .all() as any[];
  let deliveries = 0;
  for (const r of rows) {
    const have = onHand(db, r.id);
    if (!force && have > r.reorder_point) continue;
    const packs = Math.ceil((r.par_level - Math.max(0, have)) / r.pack_qty);
    if (packs <= 0) continue;
    receiveStock(db, { ingredientId: r.id, qty: packs * r.pack_qty, unitCost: r.price_fils / r.pack_qty, receivedAt: at, supplierId: r.default_supplier_id });
    deliveries++;
  }
  return deliveries;
}

export interface SimulationResult { days: number; orders: number; deliveries: number }

export function simulateHistory(db: DB, from: string, to: string): SimulationResult {
  let orders = 0, deliveries = 0;
  deliveries += restockToPar(db, `${from}T07:00:00`, true); // opening stock
  for (const day of eachDay(from, to)) {
    writeOffExpired(db, day);
    deliveries += restockToPar(db, `${day}T07:30:00`);
    const batch = parseFoodicsCsv(generateFoodicsCsv({ from: day, to: day }), `simulated-${day}.csv`);
    orders += ingestSales(db, batch, `${day}T23:00:00`).ordersNew;
    recordWaste(db, "milk_fresh", 300, `${day}T22:10:00`, "steaming / pitcher waste");
    recordWaste(db, "milk_fresh", 400, `${day}T22:15:00`, "staff drinks", "staff_drink");
    recordWaste(db, "beans_espresso", 54, `${day}T22:15:00`, "staff drinks + dial-in", "staff_drink");
  }
  return { days: eachDay(from, to).length, orders, deliveries };
}

/** Demo staff with rotas from trading start through the week containing `through` (+1 week ahead). */
export function seedDemoStaff(db: DB, from: string, through: string): number {
  for (const st of DEMO_STAFF) {
    addStaff(db, { name: st.name, role: st.role, basicFils: aedToFils(st.basicAed), housingFils: aedToFils(st.housingAed), transportFils: aedToFils(st.transportAed),
      otherFils: aedToFils(st.otherAed), restDay: parseRestDay(st.restDay), maxWeeklyHours: st.maxHours, startDate: st.start, iban: st.iban });
  }
  let shifts = 0;
  for (let ws = weekStartOf(from); ws <= addDays(through, 7); ws = addDays(ws, 7)) shifts += generateWeekRota(db, ws).created;
  // Shifts before trading start don't exist
  db.prepare("DELETE FROM shifts WHERE date < ?").run(from);
  return shifts;
}
