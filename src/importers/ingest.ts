/**
 * Ingest a SalesBatch (from any SalesSource) into the database:
 *   1. reject a batch we've already imported (same fingerprint)
 *   2. skip orders already on record (overlapping exports)
 *   3. map POS products/modifiers to menu items/modifiers
 *   4. split VAT per line, write orders + lines
 *   5. deplete stock per recipe, in chronological order, and store COGS per line
 * All in one transaction: a failed import leaves nothing behind.
 */
import type { DB } from "../db/index.js";
import { getNumberSetting } from "../db/index.js";
import { depleteOrderLine, loadRecipeBook } from "../domain/inventory.js";
import { splitVatInclusive } from "../domain/money.js";
import type { SalesBatch } from "../integrations/ports.js";

export interface IngestResult {
  duplicate: boolean;
  importId: number | null;
  ordersNew: number;
  ordersExisting: number;
  linesNew: number;
  rowsSkipped: number;
  warnings: string[];
  shortfallIngredients: string[];
  dateRange: { from: string; to: string } | null;
}

export function ingestSales(db: DB, batch: SalesBatch, now = new Date().toISOString()): IngestResult {
  const already = db.prepare("SELECT id FROM sales_imports WHERE file_sha256 = ?").get(batch.fingerprint) as { id: number } | undefined;
  if (already) {
    return { duplicate: true, importId: already.id, ordersNew: 0, ordersExisting: 0, linesNew: 0, rowsSkipped: 0, warnings: ["This exact file was already imported — nothing changed."], shortfallIngredients: [], dateRange: null };
  }

  const vatRate = getNumberSetting(db, "vat_rate");
  const book = loadRecipeBook(db);
  const bySku = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const m of db.prepare("SELECT id, sku, name_en, name_ar FROM menu_items").all() as any[]) {
    bySku.set(m.sku.toLowerCase(), m.id);
    byName.set(m.name_en.toLowerCase(), m.id);
    byName.set(m.name_ar, m.id);
  }
  const modByKey = new Map<string, string>();
  for (const m of db.prepare("SELECT code, name_en, name_ar FROM modifiers").all() as any[]) {
    modByKey.set(m.code.toLowerCase(), m.code);
    modByKey.set(m.name_en.toLowerCase(), m.code);
    modByKey.set(m.name_ar, m.code);
  }
  const ingName = new Map<number, string>((db.prepare("SELECT id, name_en FROM ingredients").all() as any[]).map((r) => [r.id, r.name_en]));

  const warnings = [...batch.warnings];
  let rowsSkipped = batch.rowsSkipped;
  let ordersNew = 0, ordersExisting = 0, linesNew = 0;
  const shortfallIds = new Set<number>();
  let minDate: string | null = null, maxDate: string | null = null;

  const exists = db.prepare("SELECT 1 FROM orders WHERE pos_ref = ?");
  const insOrder = db.prepare(
    `INSERT INTO orders (pos_ref, business_date, opened_at, order_type, payment_method, gross_fils, discount_fils, vat_fils, net_ex_vat_fils, import_id)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO order_lines (order_id, menu_item_id, qty, unit_price_fils, gross_fils, discount_fils, vat_fils, net_ex_vat_fils, modifiers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updOrder = db.prepare("UPDATE orders SET gross_fils = ?, discount_fils = ?, vat_fils = ?, net_ex_vat_fils = ? WHERE id = ?");

  const run = db.transaction(() => {
    const imp = db
      .prepare(
        `INSERT INTO sales_imports (source, file_name, file_sha256, rows_total, orders_new, lines_new, rows_skipped, warnings, imported_at)
         VALUES (?, ?, ?, ?, 0, 0, 0, '[]', ?)`,
      )
      .run(batch.source, batch.label, batch.fingerprint, batch.rowsTotal, now);
    const importId = Number(imp.lastInsertRowid);

    const orders = [...batch.orders].sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0));
    for (const o of orders) {
      if (exists.get(o.posRef)) { ordersExisting++; continue; }

      const mapped = o.lines.flatMap((l) => {
        const id = (l.sku && bySku.get(l.sku.toLowerCase())) || byName.get(l.productName.toLowerCase()) || byName.get(l.productName);
        if (!id) {
          rowsSkipped++;
          warnings.push(`Order ${o.posRef}: unknown product "${l.productName}"${l.sku ? ` (SKU ${l.sku})` : ""} — add it to the menu, line skipped`);
          return [];
        }
        const mods = l.modifiers.flatMap((m) => {
          const code = modByKey.get(m.toLowerCase()) ?? modByKey.get(m);
          if (!code) warnings.push(`Order ${o.posRef}: unknown modifier "${m}" — ignored for stock`);
          return code ? [code] : [];
        });
        return [{ ...l, menuItemId: id, mods }];
      });
      if (mapped.length === 0) continue;

      const orderId = Number(insOrder.run(o.posRef, o.businessDate, o.openedAt, o.orderType, o.paymentMethod, importId).lastInsertRowid);
      let gross = 0, disc = 0, vat = 0, net = 0;
      for (const l of mapped) {
        const lineGross = l.unitPriceFils * l.qty;
        const lineDisc = Math.max(0, lineGross - l.lineTotalFils);
        const split = splitVatInclusive(l.lineTotalFils, vatRate);
        const lineId = Number(
          insLine.run(orderId, l.menuItemId, l.qty, l.unitPriceFils, lineGross, lineDisc, split.vatFils, split.netExVatFils, JSON.stringify(l.mods)).lastInsertRowid,
        );
        const dep = depleteOrderLine(db, book, lineId, { menuItemId: l.menuItemId, qty: l.qty, modifierCodes: l.mods }, o.openedAt);
        dep.shortfalls.forEach((id) => shortfallIds.add(id));
        gross += lineGross; disc += lineDisc; vat += split.vatFils; net += split.netExVatFils;
        linesNew++;
      }
      updOrder.run(gross, disc, vat, net, orderId);
      ordersNew++;
      if (!minDate || o.businessDate < minDate) minDate = o.businessDate;
      if (!maxDate || o.businessDate > maxDate) maxDate = o.businessDate;
    }

    db.prepare("UPDATE sales_imports SET orders_new = ?, lines_new = ?, rows_skipped = ?, warnings = ? WHERE id = ?").run(
      ordersNew, linesNew, rowsSkipped, JSON.stringify(warnings), importId,
    );
    return importId;
  });

  const importId = run();
  return {
    duplicate: false,
    importId,
    ordersNew,
    ordersExisting,
    linesNew,
    rowsSkipped,
    warnings,
    shortfallIngredients: [...shortfallIds].map((id) => ingName.get(id) ?? String(id)),
    dateRange: minDate && maxDate ? { from: minDate, to: maxDate } : null,
  };
}
