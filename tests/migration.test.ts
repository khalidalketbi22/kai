import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/index.js";

describe("upgrading a database created by Phase 1", () => {
  it("adds the new purchasing columns in place and keeps existing rows", () => {
    const db = new Database(":memory:");
    // Phase 1 shape of the tables that changed
    db.exec(`
      CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, status TEXT NOT NULL,
        total_fils INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT NOT NULL, action_id INTEGER, note TEXT);
      CREATE TABLE po_lines (id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, supplier_product_id INTEGER NOT NULL,
        packs INTEGER NOT NULL, price_fils INTEGER NOT NULL);
      INSERT INTO suppliers(name) VALUES ('Biru');
      INSERT INTO purchase_orders(supplier_id, status, total_fils, created_at, created_by) VALUES (1, 'draft', 1200, 't', 'me');
    `);
    migrate(db);
    migrate(db); // idempotent
    const cols = (db.prepare("PRAGMA table_info(purchase_orders)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["vat_fils", "message", "sent_via", "sent_at", "expected_at", "received_at"]));
    expect((db.prepare("PRAGMA table_info(po_lines)").all() as any[]).map((c) => c.name)).toEqual(expect.arrayContaining(["received_packs", "reason"]));
    expect(db.prepare("SELECT total_fils, vat_fils FROM purchase_orders").get()).toEqual({ total_fils: 1200, vat_fils: 0 });
    expect((db.prepare("SELECT value FROM settings WHERE key = 'vat_quarter_start_month'").get() as any).value).toBe("1");
  });
});
