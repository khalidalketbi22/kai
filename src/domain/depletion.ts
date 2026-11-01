/**
 * Recipe-level depletion — pure functions, no database.
 *
 *   requirementsForLine()  : what one POS line consumes (recipe × qty, adjusted by modifiers)
 *   allocateFefo()         : which stock lots it comes out of (first-expiry-first-out) and what it cost
 */

export type IngredientId = number;

export interface RecipeComponent {
  ingredientId: IngredientId;
  qty: number; // base units per 1 menu item
}

export type ModifierEffect =
  | { kind: "add"; ingredientId: IngredientId; qty: number }
  | { kind: "swap"; ingredientId: IngredientId; toIngredientId: IngredientId; ratio: number };

export interface SaleLine {
  menuItemId: number;
  qty: number;
  modifierCodes: string[];
}

export class UnknownRecipeError extends Error {}

/**
 * Ingredient quantities consumed by one sale line.
 *
 * Order of application per item: base recipe → swaps → adds. Swaps move the whole quantity of an
 * ingredient (so "oat milk" works for a 60 ml cortado and a 200 ml latte alike). Results are
 * multiplied by line qty. Quantities never go negative.
 */
export function requirementsForLine(
  line: SaleLine,
  recipes: Map<number, RecipeComponent[]>,
  modifiers: Map<string, ModifierEffect[]>,
): Map<IngredientId, number> {
  const recipe = recipes.get(line.menuItemId);
  if (!recipe) throw new UnknownRecipeError(`No recipe for menu item ${line.menuItemId}`);

  const perItem = new Map<IngredientId, number>();
  for (const c of recipe) perItem.set(c.ingredientId, (perItem.get(c.ingredientId) ?? 0) + c.qty);

  const effects = line.modifierCodes.flatMap((code) => modifiers.get(code) ?? []);
  for (const e of effects) {
    if (e.kind !== "swap") continue;
    const q = perItem.get(e.ingredientId) ?? 0;
    if (q === 0) continue;
    perItem.delete(e.ingredientId);
    perItem.set(e.toIngredientId, (perItem.get(e.toIngredientId) ?? 0) + q * e.ratio);
  }
  for (const e of effects) {
    if (e.kind !== "add") continue;
    perItem.set(e.ingredientId, Math.max(0, (perItem.get(e.ingredientId) ?? 0) + e.qty));
  }

  const out = new Map<IngredientId, number>();
  for (const [id, q] of perItem) if (q > 0) out.set(id, round6(q * line.qty));
  return out;
}

/** Sum requirements over many lines (used for forecasting and "theoretical usage" reports). */
export function totalRequirements(
  lines: SaleLine[],
  recipes: Map<number, RecipeComponent[]>,
  modifiers: Map<string, ModifierEffect[]>,
): Map<IngredientId, number> {
  const total = new Map<IngredientId, number>();
  for (const l of lines) {
    for (const [id, q] of requirementsForLine(l, recipes, modifiers)) {
      total.set(id, round6((total.get(id) ?? 0) + q));
    }
  }
  return total;
}

export interface Lot {
  id: number;
  qtyRemaining: number;
  unitCost: number; // fils per base unit
  receivedAt: string;
  expiresAt: string | null;
}

export interface Allocation {
  lotId: number | null; // null = shortfall (stock ran out on paper)
  qty: number;
  cost: number; // fils, unrounded
}

export interface AllocationResult {
  allocations: Allocation[];
  shortfall: number;
  totalCost: number; // fils, unrounded
}

/**
 * Take `qty` out of the open lots, earliest expiry first (then earliest received).
 * Any quantity the lots can't cover is a shortfall, costed at `fallbackUnitCost`
 * (normally the most recent lot's cost) so COGS stays realistic even when counts drift.
 * Does not mutate the input lots.
 */
export function allocateFefo(lots: Lot[], qty: number, fallbackUnitCost: number): AllocationResult {
  if (qty < 0) throw new Error("qty must be ≥ 0");
  const ordered = lots
    .filter((l) => l.qtyRemaining > 0)
    .sort((a, b) => {
      const ea = a.expiresAt ?? "9999-12-31";
      const eb = b.expiresAt ?? "9999-12-31";
      if (ea !== eb) return ea < eb ? -1 : 1;
      if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
      return a.id - b.id;
    });

  const allocations: Allocation[] = [];
  let left = qty;
  for (const lot of ordered) {
    if (left <= EPS) break;
    const take = Math.min(lot.qtyRemaining, left);
    allocations.push({ lotId: lot.id, qty: round6(take), cost: take * lot.unitCost });
    left = round6(left - take);
  }
  const shortfall = left > EPS ? left : 0;
  if (shortfall > 0) allocations.push({ lotId: null, qty: shortfall, cost: shortfall * fallbackUnitCost });
  const totalCost = allocations.reduce((s, a) => s + a.cost, 0);
  return { allocations, shortfall, totalCost };
}

/** Theoretical cost of one menu item at given unit costs — used for margin-per-drink. */
export function recipeCost(
  menuItemId: number,
  modifierCodes: string[],
  recipes: Map<number, RecipeComponent[]>,
  modifiers: Map<string, ModifierEffect[]>,
  unitCost: (ingredientId: IngredientId) => number,
): number {
  let cost = 0;
  for (const [id, q] of requirementsForLine({ menuItemId, qty: 1, modifierCodes }, recipes, modifiers)) {
    cost += q * unitCost(id);
  }
  return cost;
}

const EPS = 1e-9;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
