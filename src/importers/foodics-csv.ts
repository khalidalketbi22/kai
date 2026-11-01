/**
 * Foodics CSV → NormalizedOrder[].
 *
 * Expects an order-items export: one row per product line, with order fields repeated on each row.
 * Foodics column names differ between report types and console versions, so every field accepts several
 * header aliases (case-insensitive). If your export uses a different header, add it to COLUMNS below.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseCsv } from "./csv.js";
import { parseAedToFils } from "../domain/money.js";
import type { NormalizedLine, NormalizedOrder, SalesBatch, SalesSource } from "../integrations/ports.js";

export const COLUMNS = {
  ref: ["order reference", "reference", "order ref", "order number", "order #", "receipt number"],
  businessDate: ["business date", "date"],
  openedAt: ["opened at", "order opened at", "created at", "order time", "time"],
  status: ["status", "order status"],
  orderType: ["type", "order type"],
  sku: ["product sku", "sku", "item sku"],
  product: ["product", "product name", "item", "item name"],
  modifiers: ["modifiers", "options", "modifier options"],
  qty: ["quantity", "qty"],
  unitPrice: ["unit price", "price"],
  discount: ["discount amount", "discount"],
  total: ["total price", "total", "line total", "final price"],
  payment: ["payment method", "payment", "payment methods"],
} as const;

const REQUIRED: (keyof typeof COLUMNS)[] = ["ref", "openedAt", "product", "qty"];
const EXCLUDED_STATUSES = new Set(["void", "voided", "returned", "cancelled", "canceled", "rejected", "refunded"]);

type ColIndex = Partial<Record<keyof typeof COLUMNS, number>>;

function indexColumns(header: string[]): ColIndex {
  const norm = header.map((h) => h.trim().toLowerCase());
  const idx: ColIndex = {};
  for (const [key, aliases] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, readonly string[]][]) {
    const i = norm.findIndex((h) => aliases.includes(h));
    if (i >= 0) idx[key] = i;
  }
  const missing = REQUIRED.filter((k) => idx[k] === undefined);
  if (missing.length) throw new Error(`Foodics CSV is missing required column(s): ${missing.join(", ")}. Found: ${header.join(" | ")}`);
  return idx;
}

/** "2026-10-12 10:23:45", "2026-10-12T10:23", "12/10/2026 10:23" → "2026-10-12T10:23:45" */
export function normalizeDateTime(raw: string): string {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/); // DD/MM/YYYY (UAE)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}`;
  throw new Error(`Unrecognised date/time: "${raw}"`);
}

export function parseFoodicsCsv(text: string, label = "foodics.csv"): SalesBatch {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSV is empty");
  const idx = indexColumns(rows[0]);
  const get = (r: string[], k: keyof typeof COLUMNS) => (idx[k] === undefined ? "" : (r[idx[k]!] ?? "").trim());

  const orders = new Map<string, NormalizedOrder>();
  const warnings: string[] = [];
  let skipped = 0;

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    try {
      const status = get(r, "status").toLowerCase();
      if (EXCLUDED_STATUSES.has(status)) { skipped++; return; }
      const ref = get(r, "ref");
      const qty = Number(get(r, "qty"));
      if (!ref || !Number.isFinite(qty) || qty <= 0) { skipped++; warnings.push(`Row ${rowNo}: missing reference or non-positive quantity — skipped`); return; }

      const openedAt = normalizeDateTime(get(r, "openedAt"));
      const bd = get(r, "businessDate");
      const businessDate = bd ? normalizeDateTime(`${bd} 00:00`).slice(0, 10) : openedAt.slice(0, 10);

      const unitPrice = parseAedToFils(get(r, "unitPrice"));
      const discount = parseAedToFils(get(r, "discount"));
      const totalRaw = get(r, "total");
      const lineTotal = totalRaw !== "" ? parseAedToFils(totalRaw) : unitPrice * qty - discount;
      if (totalRaw !== "" && unitPrice > 0 && Math.abs(unitPrice * qty - discount - lineTotal) > 1) {
        warnings.push(`Row ${rowNo}: total ${lineTotal / 100} ≠ qty×price−discount ${(unitPrice * qty - discount) / 100}; using total`);
      }

      const line: NormalizedLine = {
        sku: get(r, "sku") || null,
        productName: get(r, "product"),
        qty,
        unitPriceFils: unitPrice || Math.round(lineTotal / qty),
        lineTotalFils: lineTotal,
        modifiers: get(r, "modifiers").split(/[;|]/).map((s) => s.trim()).filter(Boolean),
      };

      const existing = orders.get(ref);
      if (existing) existing.lines.push(line);
      else
        orders.set(ref, {
          posRef: ref,
          businessDate,
          openedAt,
          orderType: get(r, "orderType") || null,
          paymentMethod: get(r, "payment") || null,
          lines: [line],
        });
    } catch (e) {
      skipped++;
      warnings.push(`Row ${rowNo}: ${(e as Error).message} — skipped`);
    }
  });

  return {
    source: "foodics_csv",
    label,
    fingerprint: createHash("sha256").update(text).digest("hex"),
    rowsTotal: rows.length - 1,
    rowsSkipped: skipped,
    warnings,
    orders: [...orders.values()],
  };
}

export class FoodicsCsvSource implements SalesSource {
  constructor(private readonly path: string) {}
  async fetch(): Promise<SalesBatch> {
    return parseFoodicsCsv(readFileSync(this.path, "utf8"), basename(this.path));
  }
}
