/**
 * Seed data for The Liwan, Arcades kiosk.
 *
 * ⚠ Illustrative numbers. Replace with real values before relying on reports:
 *   - supplier prices and which supplier carries what (the split between Windmill / Goldbox / Biru is a guess)
 *   - salaries, machine lease, other fixed costs
 *   - menu prices and recipes (grams / ml per drink)
 * Prices: menu = VAT-inclusive (what the customer pays). Supplier packs = ex-VAT.
 */

export const OWNERS = [
  { name: "Partner 1", locale: "en" },
  { name: "Partner 2", locale: "ar" },
  { name: "Partner 3", locale: "en" },
  { name: "Partner 4", locale: "ar" },
] as const;

export const CAPITAL_PER_OWNER_AED = 40_000;
export const CAPITAL_DATE = "2026-09-01";

export const SUPPLIERS = [
  { name: "Windmill", leadTimeDays: 2, minOrderAed: 300 },  // coffee beans
  { name: "Biru", leadTimeDays: 1, minOrderAed: 150 },      // dairy, spices, dates
  { name: "Goldbox", leadTimeDays: 3, minOrderAed: 250 },   // cups, lids, filters, packaging
] as const;

type Unit = "g" | "ml" | "pc";
export interface IngredientSeed {
  code: string; nameEn: string; nameAr: string; unit: Unit;
  reorderPoint: number; parLevel: number; shelfLifeDays: number | null;
  supplier: (typeof SUPPLIERS)[number]["name"];
  pack: { sku: string; description: string; qty: number; priceAed: number };
}

export const INGREDIENTS: IngredientSeed[] = [
  // Coffee
  { code: "beans_espresso", nameEn: "House espresso beans", nameAr: "حبوب الإسبريسو", unit: "g", reorderPoint: 4000, parLevel: 12000, shelfLifeDays: 60, supplier: "Windmill", pack: { sku: "WM-ESP-1KG", description: "House espresso blend 1kg", qty: 1000, priceAed: 150 } },
  { code: "beans_filter", nameEn: "Single-origin filter beans", nameAr: "حبوب قهوة مختصة للتقطير", unit: "g", reorderPoint: 750, parLevel: 2500, shelfLifeDays: 60, supplier: "Windmill", pack: { sku: "WM-SO-250", description: "Single origin 250g", qty: 250, priceAed: 75 } },
  { code: "arabic_blend", nameEn: "Arabic coffee blend", nameAr: "خلطة القهوة العربية", unit: "g", reorderPoint: 1000, parLevel: 3000, shelfLifeDays: 90, supplier: "Windmill", pack: { sku: "WM-ARB-1KG", description: "Arabic coffee light roast 1kg", qty: 1000, priceAed: 110 } },
  // Dairy
  { code: "milk_fresh", nameEn: "Fresh milk", nameAr: "حليب طازج", unit: "ml", reorderPoint: 22000, parLevel: 44000, shelfLifeDays: 7, supplier: "Biru", pack: { sku: "BR-MILK-2L", description: "Full-fat fresh milk 2L", qty: 2000, priceAed: 12 } },
  { code: "milk_oat", nameEn: "Oat milk", nameAr: "حليب الشوفان", unit: "ml", reorderPoint: 4000, parLevel: 12000, shelfLifeDays: 30, supplier: "Biru", pack: { sku: "BR-OAT-1L", description: "Barista oat milk 1L", qty: 1000, priceAed: 13.5 } },
  { code: "milk_condensed", nameEn: "Condensed milk", nameAr: "حليب مكثف", unit: "g", reorderPoint: 2400, parLevel: 6000, shelfLifeDays: 365, supplier: "Biru", pack: { sku: "BR-COND-397", description: "Sweetened condensed milk 397g", qty: 397, priceAed: 7.5 } },
  // Spices & dates
  { code: "cardamom", nameEn: "Cardamom (ground)", nameAr: "هيل مطحون", unit: "g", reorderPoint: 150, parLevel: 500, shelfLifeDays: 180, supplier: "Biru", pack: { sku: "BR-CARD-500", description: "Ground cardamom 500g", qty: 500, priceAed: 55 } },
  { code: "saffron", nameEn: "Saffron", nameAr: "زعفران", unit: "g", reorderPoint: 10, parLevel: 30, shelfLifeDays: 365, supplier: "Biru", pack: { sku: "BR-SAF-5", description: "Saffron threads 5g", qty: 5, priceAed: 70 } },
  { code: "dates", nameEn: "Khalas dates", nameAr: "تمر خلاص", unit: "pc", reorderPoint: 200, parLevel: 600, shelfLifeDays: 60, supplier: "Biru", pack: { sku: "BR-DATES-100", description: "Khalas dates, 100 pcs", qty: 100, priceAed: 45 } },
  // Packaging
  { code: "cup_4oz", nameEn: "Cup 4oz", nameAr: "كوب ٤ أونصة", unit: "pc", reorderPoint: 50, parLevel: 200, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-C4-50", description: "Paper cup 4oz ×50", qty: 50, priceAed: 12 } },
  { code: "cup_8oz", nameEn: "Cup 8oz", nameAr: "كوب ٨ أونصة", unit: "pc", reorderPoint: 100, parLevel: 300, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-C8-50", description: "Paper cup 8oz ×50", qty: 50, priceAed: 20 } },
  { code: "cup_12oz", nameEn: "Cup 12oz", nameAr: "كوب ١٢ أونصة", unit: "pc", reorderPoint: 250, parLevel: 600, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-C12-50", description: "Paper cup 12oz ×50", qty: 50, priceAed: 25 } },
  { code: "lid_hot", nameEn: "Hot lid", nameAr: "غطاء ساخن", unit: "pc", reorderPoint: 300, parLevel: 800, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-LH-100", description: "Hot lid 8/12oz ×100", qty: 100, priceAed: 18 } },
  { code: "cup_cold16", nameEn: "Cold cup 16oz", nameAr: "كوب بارد ١٦ أونصة", unit: "pc", reorderPoint: 100, parLevel: 300, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-CC16-50", description: "Clear cold cup 16oz ×50", qty: 50, priceAed: 30 } },
  { code: "lid_cold", nameEn: "Cold lid", nameAr: "غطاء بارد", unit: "pc", reorderPoint: 100, parLevel: 300, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-LC-100", description: "Cold sip lid ×100", qty: 100, priceAed: 20 } },
  { code: "finjan", nameEn: "Finjan cup (paper)", nameAr: "فنجان ورقي", unit: "pc", reorderPoint: 100, parLevel: 400, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-FIN-100", description: "Paper finjan ×100", qty: 100, priceAed: 22 } },
  { code: "filter_v60", nameEn: "V60 filter paper", nameAr: "فلتر V60", unit: "pc", reorderPoint: 50, parLevel: 200, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-V60F-100", description: "V60 02 filters ×100", qty: 100, priceAed: 28 } },
  { code: "dallah_box", nameEn: "Dallah takeaway box", nameAr: "علبة دلة سفري", unit: "pc", reorderPoint: 10, parLevel: 30, shelfLifeDays: null, supplier: "Goldbox", pack: { sku: "GB-DAL-20", description: "Insulated dallah box ×20", qty: 20, priceAed: 60 } },
];

export interface MenuSeed {
  sku: string; nameEn: string; nameAr: string; category: "espresso" | "filter" | "arabic" | "food";
  priceAed: number; // VAT-inclusive
  recipe: Record<string, number>; // ingredient code → base units per item
}

export const MENU: MenuSeed[] = [
  { sku: "LW-ESP", nameEn: "Espresso", nameAr: "إسبريسو", category: "espresso", priceAed: 16, recipe: { beans_espresso: 18, cup_4oz: 1 } },
  { sku: "LW-CRT", nameEn: "Cortado", nameAr: "كورتادو", category: "espresso", priceAed: 20, recipe: { beans_espresso: 18, milk_fresh: 60, cup_8oz: 1, lid_hot: 1 } },
  { sku: "LW-FW", nameEn: "Flat White", nameAr: "فلات وايت", category: "espresso", priceAed: 22, recipe: { beans_espresso: 18, milk_fresh: 120, cup_8oz: 1, lid_hot: 1 } },
  { sku: "LW-LAT", nameEn: "Latte", nameAr: "لاتيه", category: "espresso", priceAed: 24, recipe: { beans_espresso: 18, milk_fresh: 200, cup_12oz: 1, lid_hot: 1 } },
  { sku: "LW-SPL", nameEn: "Spanish Latte", nameAr: "سبانش لاتيه", category: "espresso", priceAed: 26, recipe: { beans_espresso: 18, milk_fresh: 180, milk_condensed: 30, cup_12oz: 1, lid_hot: 1 } },
  { sku: "LW-ICL", nameEn: "Iced Latte", nameAr: "لاتيه مثلج", category: "espresso", priceAed: 25, recipe: { beans_espresso: 18, milk_fresh: 180, cup_cold16: 1, lid_cold: 1 } },
  { sku: "LW-SAF", nameEn: "Liwan Latte (Saffron & Cardamom)", nameAr: "لاتيه الليوان (زعفران وهيل)", category: "espresso", priceAed: 28, recipe: { beans_espresso: 18, milk_fresh: 200, saffron: 0.1, cardamom: 0.5, cup_12oz: 1, lid_hot: 1 } },
  { sku: "LW-V60", nameEn: "V60 Pour-Over", nameAr: "قهوة مقطرة V60", category: "filter", priceAed: 32, recipe: { beans_filter: 15, filter_v60: 1, cup_12oz: 1, lid_hot: 1 } },
  { sku: "LW-ARC", nameEn: "Arabic Coffee (Cup)", nameAr: "قهوة عربية (فنجان)", category: "arabic", priceAed: 12, recipe: { arabic_blend: 6, cardamom: 0.5, finjan: 1, dates: 2 } },
  { sku: "LW-DAL", nameEn: "Arabic Coffee Dallah (serves 4)", nameAr: "دلة قهوة عربية (٤ أشخاص)", category: "arabic", priceAed: 45, recipe: { arabic_blend: 25, cardamom: 2, saffron: 0.05, finjan: 4, dates: 8, dallah_box: 1 } },
  { sku: "LW-DTS", nameEn: "Khalas Dates (5 pcs)", nameAr: "تمر خلاص (٥ حبات)", category: "food", priceAed: 10, recipe: { dates: 5 } },
];

export const MODIFIERS = [
  { code: "oat_milk", nameEn: "Oat Milk", nameAr: "حليب الشوفان", priceAed: 3, effects: [{ kind: "swap" as const, from: "milk_fresh", to: "milk_oat", ratio: 1 }] },
  { code: "extra_shot", nameEn: "Extra Shot", nameAr: "شوت إضافي", priceAed: 4, effects: [{ kind: "add" as const, ingredient: "beans_espresso", qty: 18 }] },
];

/** Monthly fixed costs (ex-VAT), pro-rated over the 8th→7th business month. Placeholders. */
export const FIXED_COSTS = [
  { name: "Barista salaries incl. housing & visa (2)", category: "payroll", monthlyAed: 14_000, start: "2026-10-08", end: null },
  { name: "Espresso machine lease", category: "lease", monthlyAed: 2_500, start: "2026-10-08", end: "2026-12-31" },
  { name: "Utilities & mall service charge", category: "utilities", monthlyAed: 800, start: "2026-10-08", end: null },
  { name: "Foodics subscription", category: "software", monthlyAed: 400, start: "2026-10-08", end: null },
];
