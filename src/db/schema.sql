-- The Liwan Ops — single source of truth.
-- Conventions:
--   * Money is stored as INTEGER fils (1 AED = 100 fils). Never floats for money totals.
--   * Ingredient quantities are in base units: 'g', 'ml' or 'pc'.
--   * Unit costs are REAL fils per base unit (e.g. beans at AED 160/kg = 16.0 fils/g);
--     they are only ever rounded when aggregated into a fils total.
--   * Dates are ISO strings. business_date = 'YYYY-MM-DD' in Asia/Dubai.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  phone       TEXT,               -- E.164, used for WhatsApp
  email       TEXT,
  locale      TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ar')),
  pin_hash    TEXT                -- scrypt hash for dashboard login
);

CREATE TABLE IF NOT EXISTS capital_contributions (
  id           INTEGER PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES owners(id),
  amount_fils  INTEGER NOT NULL,
  date         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distributions (
  id           INTEGER PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES owners(id),
  amount_fils  INTEGER NOT NULL,
  date         TEXT NOT NULL,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  contact_name    TEXT,
  whatsapp        TEXT,
  email           TEXT,
  lead_time_days  INTEGER NOT NULL DEFAULT 1,
  min_order_fils  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingredients (
  id                   INTEGER PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  name_en              TEXT NOT NULL,
  name_ar              TEXT NOT NULL,
  unit                 TEXT NOT NULL CHECK (unit IN ('g','ml','pc')),
  reorder_point        REAL NOT NULL DEFAULT 0,   -- base units
  par_level            REAL NOT NULL DEFAULT 0,   -- base units, target after a delivery
  shelf_life_days      INTEGER,                   -- NULL = non-perishable
  default_supplier_id  INTEGER REFERENCES suppliers(id),
  std_unit_cost        REAL NOT NULL DEFAULT 0    -- fils per base unit, fallback when no lots
);

CREATE TABLE IF NOT EXISTS supplier_products (
  id             INTEGER PRIMARY KEY,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
  ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id),
  sku            TEXT,
  description    TEXT NOT NULL,
  pack_qty       REAL NOT NULL,          -- base units per pack (e.g. 1000 g, 2000 ml, 50 pc)
  price_fils     INTEGER NOT NULL,       -- per pack, ex-VAT
  UNIQUE (supplier_id, ingredient_id, sku)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id                   INTEGER PRIMARY KEY,
  sku                  TEXT NOT NULL UNIQUE,      -- matches POS product SKU
  name_en              TEXT NOT NULL,
  name_ar              TEXT NOT NULL,
  category             TEXT NOT NULL,             -- espresso | filter | arabic | food
  price_incl_vat_fils  INTEGER NOT NULL,
  active               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipes (
  menu_item_id   INTEGER NOT NULL REFERENCES menu_items(id),
  ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id),
  qty            REAL NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS modifiers (
  id                   INTEGER PRIMARY KEY,
  code                 TEXT NOT NULL UNIQUE,
  name_en              TEXT NOT NULL,
  name_ar              TEXT NOT NULL,
  price_incl_vat_fils  INTEGER NOT NULL DEFAULT 0
);

-- kind='add'  : add qty of ingredient_id (e.g. extra shot = +18 g beans)
-- kind='swap' : replace all of ingredient_id in the recipe with to_ingredient_id
--               at ratio (e.g. oat milk swaps fresh milk 1:1, whatever the drink's volume)
CREATE TABLE IF NOT EXISTS modifier_effects (
  id                INTEGER PRIMARY KEY,
  modifier_id       INTEGER NOT NULL REFERENCES modifiers(id),
  kind              TEXT NOT NULL CHECK (kind IN ('add','swap')),
  ingredient_id     INTEGER NOT NULL REFERENCES ingredients(id),
  qty               REAL,             -- for 'add'
  to_ingredient_id  INTEGER REFERENCES ingredients(id),  -- for 'swap'
  ratio             REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock_lots (
  id             INTEGER PRIMARY KEY,
  ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id),
  qty_received   REAL NOT NULL,
  qty_remaining  REAL NOT NULL,
  unit_cost      REAL NOT NULL,          -- fils per base unit, ex-VAT
  received_at    TEXT NOT NULL,
  expires_at     TEXT,
  supplier_id    INTEGER REFERENCES suppliers(id),
  po_id          INTEGER REFERENCES purchase_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_lots_open ON stock_lots(ingredient_id, qty_remaining);

-- The stock ledger. SUM(qty) per ingredient = stock on hand.
CREATE TABLE IF NOT EXISTS stock_movements (
  id             INTEGER PRIMARY KEY,
  ingredient_id  INTEGER NOT NULL REFERENCES ingredients(id),
  lot_id         INTEGER REFERENCES stock_lots(id),   -- NULL when stock ran short (unbacked)
  qty            REAL NOT NULL,                       -- signed, base units
  cost_fils      REAL NOT NULL DEFAULT 0,             -- signed cost of this movement
  reason         TEXT NOT NULL CHECK (reason IN ('receive','sale','waste','count_adjust','staff_drink','sample')),
  ref            TEXT,                                -- e.g. 'order_line:123'
  note           TEXT,
  at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_ing_at ON stock_movements(ingredient_id, at);
CREATE INDEX IF NOT EXISTS idx_mov_reason_at ON stock_movements(reason, at);

CREATE TABLE IF NOT EXISTS sales_imports (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,          -- 'foodics_csv' | 'foodics_api' ...
  file_name     TEXT,
  file_sha256   TEXT NOT NULL UNIQUE,
  rows_total    INTEGER NOT NULL,
  orders_new    INTEGER NOT NULL,
  lines_new     INTEGER NOT NULL,
  rows_skipped  INTEGER NOT NULL,
  warnings      TEXT,                   -- JSON array
  imported_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY,
  pos_ref           TEXT NOT NULL UNIQUE,
  business_date     TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  order_type        TEXT,
  payment_method    TEXT,
  gross_fils        INTEGER NOT NULL,   -- incl. VAT, before discount
  discount_fils     INTEGER NOT NULL,
  vat_fils          INTEGER NOT NULL,
  net_ex_vat_fils   INTEGER NOT NULL,
  import_id         INTEGER REFERENCES sales_imports(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(business_date);

CREATE TABLE IF NOT EXISTS order_lines (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id),
  menu_item_id      INTEGER NOT NULL REFERENCES menu_items(id),
  qty               INTEGER NOT NULL,
  unit_price_fils   INTEGER NOT NULL,   -- incl. VAT and modifier prices
  gross_fils        INTEGER NOT NULL,
  discount_fils     INTEGER NOT NULL,
  vat_fils          INTEGER NOT NULL,
  net_ex_vat_fils   INTEGER NOT NULL,
  cogs_fils         INTEGER NOT NULL DEFAULT 0,
  modifiers         TEXT NOT NULL DEFAULT '[]'  -- JSON array of modifier codes
);
CREATE INDEX IF NOT EXISTS idx_lines_order ON order_lines(order_id);

-- Recurring and one-off costs. kind='fixed_monthly' is pro-rated over the 8th–7th business month.
CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,           -- payroll | lease | utilities | software | other
  kind          TEXT NOT NULL CHECK (kind IN ('fixed_monthly','one_off')),
  amount_fils   INTEGER NOT NULL,        -- ex-VAT; monthly amount for fixed_monthly
  start_date    TEXT NOT NULL,
  end_date      TEXT                     -- inclusive; NULL = ongoing
);

-- ---- Purchasing + approvals (Phase 2) ----
-- Lifecycle: pending_approval → approved (owner) → sent (to supplier) → received (stock booked in)
--            pending_approval → cancelled (owner rejected)
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL CHECK (status IN ('draft','pending_approval','approved','sent','received','cancelled')),
  total_fils    INTEGER NOT NULL DEFAULT 0,   -- ex-VAT
  vat_fils      INTEGER NOT NULL DEFAULT 0,   -- input VAT (5%), reclaimable
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,                -- agent name or owner
  action_id     INTEGER REFERENCES actions(id),
  note          TEXT,
  message       TEXT,                         -- text sent (or to send) to the supplier
  sent_via      TEXT,                         -- email | whatsapp | manual
  sent_at       TEXT,
  expected_at   TEXT,
  received_at   TEXT
);

CREATE TABLE IF NOT EXISTS po_lines (
  id                   INTEGER PRIMARY KEY,
  po_id                INTEGER NOT NULL REFERENCES purchase_orders(id),
  supplier_product_id  INTEGER NOT NULL REFERENCES supplier_products(id),
  packs                INTEGER NOT NULL,
  price_fils           INTEGER NOT NULL,      -- per pack, ex-VAT
  received_packs       INTEGER,
  reason               TEXT
);

-- Every side effect that spends money or contacts a supplier goes through here.
CREATE TABLE IF NOT EXISTS actions (
  id                 INTEGER PRIMARY KEY,
  type               TEXT NOT NULL,      -- send_purchase_order | payment | supplier_message ...
  payload            TEXT NOT NULL,      -- JSON
  summary            TEXT NOT NULL,
  amount_fils        INTEGER,
  status             TEXT NOT NULL CHECK (status IN ('pending_approval','approved','rejected','executed','failed')),
  proposed_by        TEXT NOT NULL,      -- agent name
  proposed_at        TEXT NOT NULL,
  decided_by         INTEGER REFERENCES owners(id),
  decided_at         TEXT,
  executed_at        TEXT,
  result             TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,           -- ask | daily_summary | weekly_report
  prompt       TEXT NOT NULL,
  output       TEXT,
  cost_usd     REAL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,             -- whatsapp | email | console
  recipient  TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,             -- sent | failed
  error      TEXT,
  sent_at    TEXT NOT NULL
);
