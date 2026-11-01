import { describe, expect, it } from "vitest";
import {
  allocateFefo,
  recipeCost,
  requirementsForLine,
  totalRequirements,
  UnknownRecipeError,
  type Lot,
  type ModifierEffect,
  type RecipeComponent,
} from "../src/domain/depletion.js";

// Ingredient ids
const BEANS = 1, MILK = 2, OAT = 3, CUP12 = 4, LID = 5, CUP4 = 6, CUP8 = 7;
// Menu ids
const ESPRESSO = 10, LATTE = 11, CORTADO = 12;

const recipes = new Map<number, RecipeComponent[]>([
  [ESPRESSO, [{ ingredientId: BEANS, qty: 18 }, { ingredientId: CUP4, qty: 1 }]],
  [LATTE, [{ ingredientId: BEANS, qty: 18 }, { ingredientId: MILK, qty: 200 }, { ingredientId: CUP12, qty: 1 }, { ingredientId: LID, qty: 1 }]],
  [CORTADO, [{ ingredientId: BEANS, qty: 18 }, { ingredientId: MILK, qty: 60 }, { ingredientId: CUP8, qty: 1 }, { ingredientId: LID, qty: 1 }]],
]);
const modifiers = new Map<string, ModifierEffect[]>([
  ["oat_milk", [{ kind: "swap", ingredientId: MILK, toIngredientId: OAT, ratio: 1 }]],
  ["extra_shot", [{ kind: "add", ingredientId: BEANS, qty: 18 }]],
]);
const obj = (m: Map<number, number>) => Object.fromEntries(m);

describe("requirementsForLine", () => {
  it("espresso uses 18 g of beans and one 4oz cup", () => {
    expect(obj(requirementsForLine({ menuItemId: ESPRESSO, qty: 1, modifierCodes: [] }, recipes, modifiers))).toEqual({ [BEANS]: 18, [CUP4]: 1 });
  });

  it("latte uses 18 g beans + 200 ml milk + cup + lid", () => {
    expect(obj(requirementsForLine({ menuItemId: LATTE, qty: 1, modifierCodes: [] }, recipes, modifiers))).toEqual({ [BEANS]: 18, [MILK]: 200, [CUP12]: 1, [LID]: 1 });
  });

  it("multiplies by line quantity", () => {
    expect(obj(requirementsForLine({ menuItemId: LATTE, qty: 3, modifierCodes: [] }, recipes, modifiers))).toEqual({ [BEANS]: 54, [MILK]: 600, [CUP12]: 3, [LID]: 3 });
  });

  it("oat milk swaps the drink's full milk volume, whatever the drink", () => {
    expect(obj(requirementsForLine({ menuItemId: LATTE, qty: 1, modifierCodes: ["oat_milk"] }, recipes, modifiers))).toEqual({ [BEANS]: 18, [OAT]: 200, [CUP12]: 1, [LID]: 1 });
    expect(obj(requirementsForLine({ menuItemId: CORTADO, qty: 2, modifierCodes: ["oat_milk"] }, recipes, modifiers))).toEqual({ [BEANS]: 36, [OAT]: 120, [CUP8]: 2, [LID]: 2 });
  });

  it("oat milk on an espresso (no milk) changes nothing", () => {
    expect(obj(requirementsForLine({ menuItemId: ESPRESSO, qty: 1, modifierCodes: ["oat_milk"] }, recipes, modifiers))).toEqual({ [BEANS]: 18, [CUP4]: 1 });
  });

  it("extra shot adds 18 g; combines with oat milk", () => {
    expect(obj(requirementsForLine({ menuItemId: LATTE, qty: 2, modifierCodes: ["oat_milk", "extra_shot"] }, recipes, modifiers))).toEqual({ [BEANS]: 72, [OAT]: 400, [CUP12]: 2, [LID]: 2 });
  });

  it("ignores unknown modifier codes", () => {
    expect(obj(requirementsForLine({ menuItemId: ESPRESSO, qty: 1, modifierCodes: ["caramel"] }, recipes, modifiers))).toEqual({ [BEANS]: 18, [CUP4]: 1 });
  });

  it("throws for a menu item without a recipe", () => {
    expect(() => requirementsForLine({ menuItemId: 999, qty: 1, modifierCodes: [] }, recipes, modifiers)).toThrow(UnknownRecipeError);
  });

  it("avoids floating-point drift on fractional quantities (0.1 g saffron × 3)", () => {
    const r = new Map([[1, [{ ingredientId: 9, qty: 0.1 }]]]);
    expect(requirementsForLine({ menuItemId: 1, qty: 3, modifierCodes: [] }, r, new Map()).get(9)).toBe(0.3);
  });
});

describe("totalRequirements", () => {
  it("sums across lines: a 1 kg bag covers 55 espressos (18 g each) with 10 g left", () => {
    const lines = Array.from({ length: 55 }, () => ({ menuItemId: ESPRESSO, qty: 1, modifierCodes: [] }));
    const total = totalRequirements(lines, recipes, modifiers);
    expect(total.get(BEANS)).toBe(990);
    expect(1000 - total.get(BEANS)!).toBe(10);
  });

  it("mixed order", () => {
    const total = totalRequirements(
      [
        { menuItemId: LATTE, qty: 2, modifierCodes: [] },
        { menuItemId: CORTADO, qty: 1, modifierCodes: [] },
        { menuItemId: LATTE, qty: 1, modifierCodes: ["oat_milk"] },
      ],
      recipes,
      modifiers,
    );
    expect(obj(total)).toEqual({ [BEANS]: 72, [MILK]: 460, [OAT]: 200, [CUP12]: 3, [CUP8]: 1, [LID]: 4 });
  });
});

describe("allocateFefo", () => {
  const lots: Lot[] = [
    { id: 1, qtyRemaining: 1000, unitCost: 0.6, receivedAt: "2026-10-01T07:00:00", expiresAt: "2026-10-08" },
    { id: 2, qtyRemaining: 2000, unitCost: 0.7, receivedAt: "2026-10-03T07:00:00", expiresAt: "2026-10-10" },
  ];

  it("takes from the earliest-expiring lot first", () => {
    const r = allocateFefo(lots, 400, 0.7);
    expect(r.allocations).toEqual([{ lotId: 1, qty: 400, cost: 240 }]);
    expect(r.shortfall).toBe(0);
    expect(r.totalCost).toBeCloseTo(240);
  });

  it("spans lots and costs each part at its own lot price", () => {
    const r = allocateFefo(lots, 1500, 0.7);
    expect(r.allocations.map((a) => [a.lotId, a.qty])).toEqual([[1, 1000], [2, 500]]);
    expect(r.totalCost).toBeCloseTo(1000 * 0.6 + 500 * 0.7); // 950 fils
  });

  it("orders by expiry, not by received date", () => {
    const r = allocateFefo(
      [
        { id: 7, qtyRemaining: 100, unitCost: 1, receivedAt: "2026-10-01", expiresAt: "2026-12-01" },
        { id: 8, qtyRemaining: 100, unitCost: 2, receivedAt: "2026-10-05", expiresAt: "2026-10-20" },
      ],
      50,
      1,
    );
    expect(r.allocations[0].lotId).toBe(8);
  });

  it("non-perishable lots (no expiry) are used oldest first, after dated lots", () => {
    const r = allocateFefo(
      [
        { id: 1, qtyRemaining: 10, unitCost: 1, receivedAt: "2026-10-02", expiresAt: null },
        { id: 2, qtyRemaining: 10, unitCost: 1, receivedAt: "2026-10-01", expiresAt: null },
        { id: 3, qtyRemaining: 10, unitCost: 1, receivedAt: "2026-10-03", expiresAt: "2027-01-01" },
      ],
      25,
      1,
    );
    expect(r.allocations.map((a) => a.lotId)).toEqual([3, 2, 1]);
  });

  it("records a shortfall costed at the fallback cost when stock runs out", () => {
    const r = allocateFefo(lots, 3500, 0.8);
    expect(r.shortfall).toBe(500);
    expect(r.allocations.at(-1)).toEqual({ lotId: null, qty: 500, cost: 400 });
    expect(r.totalCost).toBeCloseTo(600 + 1400 + 400);
  });

  it("skips empty lots and does not mutate input", () => {
    const input: Lot[] = [{ id: 1, qtyRemaining: 0, unitCost: 1, receivedAt: "a", expiresAt: null }, { id: 2, qtyRemaining: 5, unitCost: 2, receivedAt: "b", expiresAt: null }];
    const r = allocateFefo(input, 3, 2);
    expect(r.allocations).toEqual([{ lotId: 2, qty: 3, cost: 6 }]);
    expect(input[1].qtyRemaining).toBe(5);
  });

  it("zero quantity allocates nothing; negative throws", () => {
    expect(allocateFefo(lots, 0, 1).allocations).toEqual([]);
    expect(() => allocateFefo(lots, -1, 1)).toThrow();
  });
});

describe("recipeCost", () => {
  it("latte at beans 15 fils/g, milk 0.6 fils/ml, cup 50, lid 18 = 458 fils", () => {
    const cost: Record<number, number> = { [BEANS]: 15, [MILK]: 0.6, [CUP12]: 50, [LID]: 18 };
    expect(recipeCost(LATTE, [], recipes, modifiers, (id) => cost[id])).toBeCloseTo(18 * 15 + 200 * 0.6 + 50 + 18);
  });
});
