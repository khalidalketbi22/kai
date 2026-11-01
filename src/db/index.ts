import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** Business defaults. Stored in the `settings` table so owners can change them without a deploy. */
export const DEFAULT_SETTINGS: Record<string, string> = {
  currency: "AED",
  timezone: "Asia/Dubai",
  vat_rate: "0.05",
  rent_pct: "0.15",                // rent = 15% of net (ex-VAT) sales ...
  rent_start_date: "2026-11-01",   // ... from 1 Nov 2026
  business_month_start_day: "8",   // business month runs 8th → 7th (staff paid on the 8th)
  trading_start_date: "2026-10-08",
  capital_target_fils: "16000000", // 4 owners × AED 40,000
  payback_months: "12",
  expiry_warning_days: "2",
};

export function openDb(path = process.env.LIWAN_DB ?? "data/liwan.db"): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  const ins = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

export function getSetting(db: DB, key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (row) return row.value;
  const d = DEFAULT_SETTINGS[key];
  if (d === undefined) throw new Error(`Unknown setting: ${key}`);
  return d;
}

export const getNumberSetting = (db: DB, key: string) => Number(getSetting(db, key));
