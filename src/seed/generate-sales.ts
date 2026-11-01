/**
 * Deterministic generator of realistic Foodics-format order-item CSVs for testing/demo.
 * Same seed → same file. Models: opening ramp-up, UAE weekend (Fri–Sun busier), afternoon/evening mall peaks,
 * drink mix, oat milk / extra shot modifiers, occasional discounts and voids.
 */
import { toCsv } from "../importers/csv.js";
import { dayOfWeek, daysBetweenInclusive, eachDay } from "../domain/periods.js";
import { MENU, MODIFIERS } from "./data.js";

export const FOODICS_HEADER = [
  "Order Reference", "Business Date", "Opened At", "Status", "Order Type", "Product SKU", "Product",
  "Modifiers", "Quantity", "Unit Price", "Discount Amount", "Total Price", "Payment Method",
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIX: Record<string, number> = {
  "LW-SPL": 18, "LW-LAT": 13, "LW-SAF": 11, "LW-ICL": 10, "LW-V60": 9, "LW-ARC": 9,
  "LW-FW": 8, "LW-DAL": 4, "LW-CRT": 3, "LW-ESP": 3, "LW-DTS": 3,
};
const HOUR_WEIGHTS: Record<number, number> = { 10: 1, 11: 2, 12: 3, 13: 3, 14: 2, 15: 2, 16: 3, 17: 4, 18: 4, 19: 5, 20: 5, 21: 4 };
const DOW_FACTOR = [1.1, 0.85, 0.85, 0.9, 1.0, 1.15, 1.3]; // Sun..Sat
const MILK_SKUS = new Set(["LW-CRT", "LW-FW", "LW-LAT", "LW-SPL", "LW-ICL", "LW-SAF"]);
const ESPRESSO_SKUS = new Set([...MILK_SKUS, "LW-ESP"]);

function pick<T>(rand: () => number, weights: [T, number][]): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of weights) { if ((r -= w) < 0) return v; }
  return weights[weights.length - 1][0];
}

export interface GenerateOptions { from: string; to: string; tradingStart?: string; seed?: number }

export function generateFoodicsRows(opts: GenerateOptions): string[][] {
  const tradingStart = opts.tradingStart ?? "2026-10-08";
  const rows: string[][] = [];
  const menuWeights = Object.entries(MIX) as [string, number][];
  const hourWeights = Object.entries(HOUR_WEIGHTS).map(([h, w]) => [Number(h), w]) as [number, number][];
  const bySku = new Map(MENU.map((m) => [m.sku, m]));
  const oat = MODIFIERS.find((m) => m.code === "oat_milk")!;
  const shot = MODIFIERS.find((m) => m.code === "extra_shot")!;

  for (const day of eachDay(opts.from, opts.to)) {
    const rand = mulberry32((opts.seed ?? 2026) * 100_000 + Number(day.replace(/-/g, "")) % 100_000);
    const dayIndex = Math.max(0, daysBetweenInclusive(tradingStart, day) - 1);
    const base = 40 + 30 * Math.min(1, dayIndex / 24); // ~40 orders/day at opening → ~70 after 3–4 weeks
    const nOrders = Math.round(base * DOW_FACTOR[dayOfWeek(day)] * (0.92 + rand() * 0.16));

    const orders = Array.from({ length: nOrders }, () => {
      const hour = pick(rand, hourWeights);
      const minute = Math.floor(rand() * 60), second = Math.floor(rand() * 60);
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    }).sort();

    orders.forEach((time, i) => {
      const ref = `LW${day.replace(/-/g, "").slice(2)}-${String(i + 1).padStart(4, "0")}`;
      const status = rand() < 0.01 ? "Void" : "Closed";
      const type = rand() < 0.1 ? "Dine In" : "Takeaway";
      const payment = rand() < 0.12 ? "Cash" : "Card";
      const discounted = rand() < 0.05; // e.g. mall staff 10% discount
      const nItems = pick(rand, [[1, 70], [2, 22], [3, 8]] as [number, number][]);
      for (let k = 0; k < nItems; k++) {
        const sku = pick(rand, menuWeights);
        const item = bySku.get(sku)!;
        const mods: string[] = [];
        let unit = item.priceAed;
        if (MILK_SKUS.has(sku) && rand() < 0.15) { mods.push(oat.nameEn); unit += oat.priceAed; }
        if (ESPRESSO_SKUS.has(sku) && rand() < 0.08) { mods.push(shot.nameEn); unit += shot.priceAed; }
        const qty = rand() < 0.08 ? 2 : 1;
        const gross = unit * qty;
        const discount = discounted ? Math.round(gross * 10) / 100 : 0;
        rows.push([
          ref, day, `${day} ${time}`, status, type, sku, item.nameEn, mods.join("; "), String(qty),
          unit.toFixed(2), discount.toFixed(2), (gross - discount).toFixed(2), payment,
        ]);
      }
    });
  }
  return rows;
}

export function generateFoodicsCsv(opts: GenerateOptions): string {
  return toCsv([FOODICS_HEADER, ...generateFoodicsRows(opts)]);
}
