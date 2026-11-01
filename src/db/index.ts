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
  vat_quarter_start_month: "1",    // VAT quarters Jan–Mar, Apr–Jun, … (change to match your FTA tax periods)
  cash_balance_fils: "",           // last known bank + till balance, for the cash-flow forecast
  cash_balance_date: "",
  kiosk_address: "The Liwan kiosk, The Arcades, Abu Dhabi",
  // Staff (Phase 3). Shift templates: working hours exclude the break.
  shift_templates: JSON.stringify([
    { code: "open", label: "Opening", start: "10:00", end: "19:00", break: 60 },
    { code: "close", label: "Closing", start: "13:00", end: "22:00", break: 60 },
  ]),
  max_daily_hours: "8",
  overtime_premium: "0.25",        // overtime = basic hourly wage + 25% …
  night_overtime_premium: "0.5",   // … + 50% for overtime worked 22:00–04:00
  payroll_day_divisor: "30",       // daily wage for unpaid absence = (basic + allowances) / 30
  gratuity_days_per_year: "21",    // end-of-service accrual estimate: 21 days' basic per year of service
  payroll_prep_day: "6",           // draft payroll on the 6th for the month ending the 7th, paid on the 8th
};

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS doesn't alter existing tables,
 * so databases created by an older version get these added in place (data is kept).
 */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  purchase_orders: {
    vat_fils: "INTEGER NOT NULL DEFAULT 0",
    message: "TEXT",
    sent_via: "TEXT",
    sent_at: "TEXT",
    expected_at: "TEXT",
    received_at: "TEXT",
  },
  po_lines: { received_packs: "INTEGER", reason: "TEXT" },
};

function addMissingColumns(db: DB): void {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

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
  addMissingColumns(db);
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
