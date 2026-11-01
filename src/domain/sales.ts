/** Sales analytics (read-only queries over imported POS data). */
import type { DB } from "../db/index.js";
import { getNumberSetting } from "../db/index.js";
import { recipeCost } from "./depletion.js";
import { currentUnitCost, loadRecipeBook } from "./inventory.js";
import { splitVatInclusive } from "./money.js";
import { eachDay, type ISODate } from "./periods.js";
import type { DaySales } from "./pnl.js";

/** Per-day sales + COGS + waste, including zero days, ready for the P&L. */
export function dailySales(db: DB, from: ISODate, to: ISODate): DaySales[] {
  const sales = new Map<string, any>();
  for (const r of db
    .prepare(
      `SELECT o.business_date AS d, COUNT(*) AS orders, SUM(o.gross_fils) AS gross, SUM(o.discount_fils) AS disc,
              SUM(o.vat_fils) AS vat, SUM(o.net_ex_vat_fils) AS net,
              (SELECT COALESCE(SUM(l.cogs_fils),0) FROM order_lines l JOIN orders o2 ON o2.id = l.order_id WHERE o2.business_date = o.business_date) AS cogs
       FROM orders o WHERE o.business_date BETWEEN ? AND ? GROUP BY o.business_date`,
    )
    .all(from, to) as any[])
    sales.set(r.d, r);

  // Waste & shrinkage: everything that left stock without being sold (waste, staff drinks, samples, count adjustments).
  const waste = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT substr(at,1,10) AS d, -SUM(cost_fils) AS cost FROM stock_movements
       WHERE reason IN ('waste','staff_drink','sample','count_adjust') AND substr(at,1,10) BETWEEN ? AND ? GROUP BY d`,
    )
    .all(from, to) as any[])
    waste.set(r.d, Math.round(r.cost));

  return eachDay(from, to).map((d) => {
    const s = sales.get(d);
    return {
      date: d,
      orders: s?.orders ?? 0,
      grossFils: s?.gross ?? 0,
      discountFils: s?.disc ?? 0,
      vatFils: s?.vat ?? 0,
      netExVatFils: s?.net ?? 0,
      cogsFils: s?.cogs ?? 0,
      wasteFils: waste.get(d) ?? 0,
    };
  });
}

export interface SalesSummary {
  from: ISODate;
  to: ISODate;
  orders: number;
  items: number;
  grossFils: number;
  discountFils: number;
  vatFils: number;
  netExVatFils: number;
  cogsFils: number;
  avgTicketInclVatFils: number; // what the customer paid, per order
  avgTicketExVatFils: number;
  itemsPerOrder: number;
}

export function salesSummary(db: DB, from: ISODate, to: ISODate): SalesSummary {
  const o = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(gross_fils),0) AS gross, COALESCE(SUM(discount_fils),0) AS disc,
              COALESCE(SUM(vat_fils),0) AS vat, COALESCE(SUM(net_ex_vat_fils),0) AS net
       FROM orders WHERE business_date BETWEEN ? AND ?`,
    )
    .get(from, to) as any;
  const l = db
    .prepare(
      `SELECT COALESCE(SUM(l.qty),0) AS items, COALESCE(SUM(l.cogs_fils),0) AS cogs
       FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.business_date BETWEEN ? AND ?`,
    )
    .get(from, to) as any;
  const paid = o.gross - o.disc;
  return {
    from,
    to,
    orders: o.orders,
    items: l.items,
    grossFils: o.gross,
    discountFils: o.disc,
    vatFils: o.vat,
    netExVatFils: o.net,
    cogsFils: l.cogs,
    avgTicketInclVatFils: o.orders ? Math.round(paid / o.orders) : 0,
    avgTicketExVatFils: o.orders ? Math.round(o.net / o.orders) : 0,
    itemsPerOrder: o.orders ? Math.round((l.items / o.orders) * 100) / 100 : 0,
  };
}

export interface ItemPerformance {
  sku: string;
  nameEn: string;
  nameAr: string;
  category: string;
  qty: number;
  netExVatFils: number;
  cogsFils: number;
  marginFils: number;
  marginPct: number;
  shareOfNet: number;
}

/** Every active menu item (zero sellers included), sorted by qty sold desc. */
export function itemPerformance(db: DB, from: ISODate, to: ISODate): ItemPerformance[] {
  const rows = db
    .prepare(
      `SELECT m.sku, m.name_en, m.name_ar, m.category,
              COALESCE(SUM(x.qty),0) AS qty, COALESCE(SUM(x.net),0) AS net, COALESCE(SUM(x.cogs),0) AS cogs
       FROM menu_items m
       LEFT JOIN (SELECT l.menu_item_id, l.qty, l.net_ex_vat_fils AS net, l.cogs_fils AS cogs
                  FROM order_lines l JOIN orders o ON o.id = l.order_id
                  WHERE o.business_date BETWEEN ? AND ?) x ON x.menu_item_id = m.id
       WHERE m.active = 1
       GROUP BY m.id ORDER BY qty DESC, net DESC`,
    )
    .all(from, to) as any[];
  const totalNet = rows.reduce((s, r) => s + r.net, 0);
  return rows.map((r) => ({
    sku: r.sku,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    category: r.category,
    qty: r.qty,
    netExVatFils: r.net,
    cogsFils: r.cogs,
    marginFils: r.net - r.cogs,
    marginPct: r.net ? (r.net - r.cogs) / r.net : 0,
    shareOfNet: totalNet ? r.net / totalNet : 0,
  }));
}

export function bestAndWorst(db: DB, from: ISODate, to: ISODate, n = 3) {
  const all = itemPerformance(db, from, to);
  return { best: all.slice(0, n), worst: all.slice(-n).reverse() };
}

export interface HourBucket { hour: number; orders: number; netExVatFils: number; avgOrdersPerDay: number }

export function peakHours(db: DB, from: ISODate, to: ISODate): HourBucket[] {
  const days = (db.prepare("SELECT COUNT(DISTINCT business_date) AS n FROM orders WHERE business_date BETWEEN ? AND ?").get(from, to) as any).n || 1;
  return (
    db
      .prepare(
        `SELECT CAST(substr(opened_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS orders, SUM(net_ex_vat_fils) AS net
         FROM orders WHERE business_date BETWEEN ? AND ? GROUP BY hour ORDER BY hour`,
      )
      .all(from, to) as any[]
  ).map((r) => ({ hour: r.hour, orders: r.orders, netExVatFils: r.net, avgOrdersPerDay: Math.round((r.orders / days) * 10) / 10 }));
}

export interface MenuMargin {
  sku: string;
  nameEn: string;
  nameAr: string;
  priceInclVatFils: number;
  priceExVatFils: number;
  recipeCostFils: number;
  marginFils: number;
  marginPct: number;
}

/** Theoretical margin per drink at today's ingredient costs (latest purchase price). */
export function menuMargins(db: DB): MenuMargin[] {
  const book = loadRecipeBook(db);
  const vat = getNumberSetting(db, "vat_rate");
  const cost = new Map<number, number>();
  const unitCost = (id: number) => {
    if (!cost.has(id)) cost.set(id, currentUnitCost(db, id));
    return cost.get(id)!;
  };
  return (db.prepare("SELECT id, sku, name_en, name_ar, price_incl_vat_fils FROM menu_items WHERE active = 1 ORDER BY name_en").all() as any[]).map((m) => {
    const ex = splitVatInclusive(m.price_incl_vat_fils, vat).netExVatFils;
    const rc = book.recipes.has(m.id) ? Math.round(recipeCost(m.id, [], book.recipes, book.modifiers, unitCost)) : 0;
    return {
      sku: m.sku,
      nameEn: m.name_en,
      nameAr: m.name_ar,
      priceInclVatFils: m.price_incl_vat_fils,
      priceExVatFils: ex,
      recipeCostFils: rc,
      marginFils: ex - rc,
      marginPct: ex ? (ex - rc) / ex : 0,
    };
  });
}

export function latestBusinessDate(db: DB): ISODate | null {
  return (db.prepare("SELECT MAX(business_date) AS d FROM orders").get() as any).d ?? null;
}
