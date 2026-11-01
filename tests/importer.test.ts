import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/importers/csv.js";
import { normalizeDateTime, parseFoodicsCsv } from "../src/importers/foodics-csv.js";
import { ingestSales } from "../src/importers/ingest.js";
import { freshDb, H, receive, stock } from "./helpers.js";

describe("CSV parser", () => {
  it("handles quotes, embedded commas/newlines, escaped quotes, CRLF and BOM", () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",\r\n';
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["2", "multi\nline", ""]]);
  });
});

describe("Foodics CSV parsing", () => {
  it("groups rows into orders and skips voids", () => {
    const b = parseFoodicsCsv(
      [H,
        "A1,2026-11-01,2026-11-01 10:05:00,Closed,Takeaway,LW-LAT,Latte,,1,24.00,0.00,24.00,Card",
        "A1,2026-11-01,2026-11-01 10:05:00,Closed,Takeaway,LW-ESP,Espresso,Extra Shot,1,20.00,0.00,20.00,Card",
        "A2,2026-11-01,2026-11-01 11:00:00,Void,Takeaway,LW-LAT,Latte,,1,24.00,0.00,24.00,Card",
      ].join("\n"),
    );
    expect(b.orders).toHaveLength(1);
    expect(b.orders[0].lines).toHaveLength(2);
    expect(b.orders[0].lines[1].modifiers).toEqual(["Extra Shot"]);
    expect(b.rowsSkipped).toBe(1);
  });

  it("accepts alternative header names", () => {
    const b = parseFoodicsCsv("Reference,Created At,SKU,Item,Qty,Price,Total\nR9,2026-11-01 09:00,LW-ESP,Espresso,2,16,32\n");
    expect(b.orders[0]).toMatchObject({ posRef: "R9", businessDate: "2026-11-01", openedAt: "2026-11-01T09:00:00" });
    expect(b.orders[0].lines[0]).toMatchObject({ qty: 2, unitPriceFils: 1600, lineTotalFils: 3200 });
  });

  it("fails clearly when required columns are missing", () => {
    expect(() => parseFoodicsCsv("Foo,Bar\n1,2\n")).toThrow(/missing required column/);
  });

  it("parses UAE day-first dates", () => expect(normalizeDateTime("01/11/2026 21:30")).toBe("2026-11-01T21:30:00"));
});

describe("ingestSales", () => {
  const csv = [H,
    "A1,2026-11-01,2026-11-01 10:05:00,Closed,Takeaway,LW-LAT,Latte,Oat Milk,2,27.00,0.00,54.00,Card",
    "A2,2026-11-01,2026-11-01 10:20:00,Closed,Takeaway,LW-ESP,Espresso,,1,16.00,1.60,14.40,Cash",
  ].join("\n");

  it("writes orders with VAT split per line and depletes stock by recipe", () => {
    const db = freshDb();
    receive(db, "beans_espresso", 1000, 15, "2026-10-31T08:00:00");
    receive(db, "milk_oat", 1000, 1.35, "2026-10-31T08:00:00");
    receive(db, "cup_12oz", 50, 50, "2026-10-31T08:00:00");
    receive(db, "lid_hot", 100, 18, "2026-10-31T08:00:00");
    receive(db, "cup_4oz", 50, 24, "2026-10-31T08:00:00");

    const r = ingestSales(db, parseFoodicsCsv(csv, "t.csv"));
    expect(r).toMatchObject({ duplicate: false, ordersNew: 2, linesNew: 2, shortfallIngredients: [] });

    const o1 = db.prepare("SELECT * FROM orders WHERE pos_ref = 'A1'").get() as any;
    expect(o1).toMatchObject({ gross_fils: 5400, discount_fils: 0, vat_fils: 257, net_ex_vat_fils: 5143 });
    const o2 = db.prepare("SELECT * FROM orders WHERE pos_ref = 'A2'").get() as any;
    expect(o2).toMatchObject({ gross_fils: 1600, discount_fils: 160, vat_fils: 69, net_ex_vat_fils: 1371 });

    // 2 oat lattes + 1 espresso = 54 g beans, 400 ml oat milk (no dairy), 2 cups 12oz, 2 lids, 1 cup 4oz
    expect(stock(db, "beans_espresso")).toBe(1000 - 54);
    expect(stock(db, "milk_oat")).toBe(600);
    expect(stock(db, "milk_fresh")).toBe(0);
    expect(stock(db, "cup_12oz")).toBe(48);
    expect(stock(db, "lid_hot")).toBe(98);
    expect(stock(db, "cup_4oz")).toBe(49);

    // COGS for the latte line: 36 g × 15 + 400 ml × 1.35 + 2 × 50 + 2 × 18 = 540 + 540 + 100 + 36 = 1216 fils
    const line = db.prepare("SELECT cogs_fils FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.pos_ref = 'A1'").get() as any;
    expect(line.cogs_fils).toBe(1216);
  });

  it("is idempotent: same file is refused, overlapping exports skip existing orders", () => {
    const db = freshDb();
    expect(ingestSales(db, parseFoodicsCsv(csv)).ordersNew).toBe(2);
    expect(ingestSales(db, parseFoodicsCsv(csv)).duplicate).toBe(true);
    const overlap = csv + "\nA3,2026-11-01,2026-11-01 12:00:00,Closed,Takeaway,LW-ESP,Espresso,,1,16.00,0,16.00,Card";
    const r = ingestSales(db, parseFoodicsCsv(overlap));
    expect(r).toMatchObject({ ordersNew: 1, ordersExisting: 2 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n).toBe(3);
    // stock is depleted once per order, not per import (no stock on record, so it shows as a shortfall)
    expect(stock(db, "beans_espresso")).toBe(-(36 + 18 + 18));
  });

  it("warns on unknown products and modifiers, and matches by name when SKU is missing", () => {
    const db = freshDb();
    const r = ingestSales(db, parseFoodicsCsv([H,
      "B1,2026-11-01,2026-11-01 10:00:00,Closed,Takeaway,,Flat White,Caramel,1,22,0,22,Card",
      "B2,2026-11-01,2026-11-01 10:01:00,Closed,Takeaway,XX-1,Matcha,,1,25,0,25,Card",
    ].join("\n")));
    expect(r.ordersNew).toBe(1);
    expect(r.rowsSkipped).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/unknown modifier "Caramel"/);
    expect(r.warnings.join(" ")).toMatch(/unknown product "Matcha"/);
  });

  it("flags shortfalls when sales exceed stock on record", () => {
    const db = freshDb();
    receive(db, "beans_espresso", 10, 15, "2026-10-31T08:00:00");
    const r = ingestSales(db, parseFoodicsCsv([H, "C1,2026-11-01,2026-11-01 10:00:00,Closed,Takeaway,LW-ESP,Espresso,,1,16,0,16,Card"].join("\n")));
    expect(r.shortfallIngredients).toContain("House espresso beans");
    expect(stock(db, "beans_espresso")).toBe(-8);
  });

  it("rolls back completely on failure", () => {
    const db = freshDb();
    db.exec("DROP TABLE recipes; CREATE TABLE recipes (menu_item_id INTEGER, ingredient_id INTEGER, qty REAL)"); // recipes now empty
    expect(() => ingestSales(db, parseFoodicsCsv(csv))).toThrow(/No recipe/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM sales_imports").get() as any).n).toBe(0);
  });
});
