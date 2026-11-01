# Architecture

## Principles

1. **SQLite is the single source of truth.** All agents read from it, and every money amount is integer fils.
2. **Agents never do arithmetic.** Depletion, COGS, VAT, rent, P&L and payback are plain TypeScript functions
   (`src/domain/`) with unit tests. Agents call tools that return those results, then interpret and draft.
3. **Agents can't act alone.** In Phase 1 every agent tool is read-only (`get_*`). From Phase 2, agents can only
   *propose* an order, payment or supplier message. That creates an `actions` row in `pending_approval`.
   Separate executor code (not an LLM) carries it out after **any one owner** approves, and logs who and when.
4. **Ports for integrations.** `SalesSource` (Foodics CSV now, Foodics API later), `PaymentsSource` (VaultsPay),
   `Notifier` (WhatsApp, email, console). See `src/integrations/ports.ts`.

## Layout

```
src/
  db/            schema.sql (all tables, incl. Phase 2 purchasing/approvals), open + migrate, settings
  domain/        pure maths: depletion.ts, pnl.ts, payback.ts, money.ts, periods.ts
                 DB services: inventory.ts (stock ledger, FEFO lots), sales.ts, finance.ts
  importers/     csv.ts, foodics-csv.ts (header aliases), ingest.ts (vendor-neutral, one transaction)
  agents/        tools.ts (in-process MCP server), definitions.ts (subagents), orchestrator.ts
  reports/       reports.ts (deterministic daily/weekly + EN/AR rendering), summary.ts (send + agent insights)
  integrations/  ports.ts, notifiers/ (whatsapp, console), notify.ts
  web/           Hono server-rendered dashboard, per-owner PIN login
  seed/          reference data, deterministic Foodics CSV generator, history simulation
  scheduler.ts   node-cron, Asia/Dubai
  cli.ts
tests/           depletion, P&L/VAT/rent/payback, importer, stock ledger, integrations
```

## Agents (Claude Agent SDK)

The Orchestrator is the main `query()`. Specialists are SDK subagents (`agents` option), each with its own prompt
and a tool allow-list from the in-process MCP server `liwan`. Built-in Claude Code tools are disabled
(`tools: ["Agent"]`), with `permissionMode: "dontAsk"` and `settingSources: []`, so the agents can only use the
Liwan tools and delegate to each other.

| Agent | Phase | Tools |
|---|---|---|
| Orchestrator | 1 | daily/weekly report, P&L, payback, freshness; delegates |
| Inventory | 1 | stock status, alerts, ingredient usage, recipes, margins |
| Sales analyst | 1 | sales summary, item performance, peak hours, margins |
| Purchasing | 2 | + `propose_purchase_order` (reorder point → par, pack rounding, min order, lead time) |
| Finance | 2 | P&L, VAT quarter, 13-week cash-flow forecast, payback, + `propose_payment` |
| Staff | 3 | rota, hours, payroll prep for the 8th (payroll run = approval action) |
| Customer/marketing | 4 | reviews, bilingual Instagram ideas tied to slow sellers, posting needs approval |

## Stock model

- `stock_movements` is the ledger: on hand = `SUM(qty)`.
- `stock_lots` hold the remaining quantity, unit cost and expiry of each delivery.
- Sales consume lots **first-expiry-first-out**, using only lots received before the sale and not yet expired.
- If sales exceed stock on record, the extra is booked as a *shortfall* (movement with no lot), costed at the latest
  price, and flagged as "count needed".
- Modifiers are `add` (extra shot +18 g) or `swap` (oat milk replaces all the fresh milk 1:1, whatever the drink size).

## Money model

- **Menu prices include VAT.** Per line: VAT = total × 5/105, rounded to the fils.
- **Rent:** 15% of net ex-VAT sales, only from `rent_start_date` (2026-11-01).
- **Fixed monthly costs** are spread over the 8th→7th business month with cumulative rounding, so the daily shares
  add up to exactly the monthly amount. The machine lease has `end_date` 2026-12-31.
- **Payback:** cumulative operating profit since 8 Oct 2026 vs AED 160,000, with a target of 7 Oct 2027.
  - The projection uses the trailing 28-day run-rate.
  - Days before rent started are charged rent in the projection, so the rent-free opening doesn't flatter it.

## Phase plan

1. **Done:** inventory + sales from a Foodics CSV, P&L core, read-only agents, daily/weekly reports, WhatsApp sender, dashboard.
2. **Purchasing and finance:**
   - PO drafts from reorder points.
   - Approvals in the dashboard and by WhatsApp buttons; the executor sends POs to suppliers once approved.
   - Receiving POs into stock lots; input VAT from purchases.
   - Finance agent, 13-week cash-flow forecast, Sunday report with VAT position.
3. **Staff:** rota, timesheets, payroll prep for the 8th.
4. **Customer/marketing:** Google Business Profile reviews, Instagram ideas for slow sellers.
5. **Live connections:**
   - Foodics API/webhooks as a `SalesSource`, VaultsPay settlements as a `PaymentsSource` for card reconciliation.
   - Litestream backups, Docker deploy.
