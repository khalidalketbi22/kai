# Architecture

## Principles

1. **SQLite is the single source of truth.** All agents read from it, and every money amount is integer fils.
2. **Agents never do arithmetic.** Depletion, COGS, VAT, rent, P&L and payback are plain TypeScript functions
   (`src/domain/`) with unit tests. Agents call tools that return those results, then interpret and draft.
3. **Agents can't act alone.** Agent tools are read-only (`get_*`) plus one drafting tool for the Purchasing agent
   (`propose_purchase_orders`). Drafting creates a purchase order and an `actions` row in `pending_approval`.
   Only an owner can approve or reject, in the dashboard or the CLI. Executor code (`src/domain/approvals.ts`, no LLM)
   then emails the order to the supplier, or prepares the message for an owner to send. It logs who decided and when.
   Every transition is a conditional update, so nothing can be approved or sent twice. A test checks that no agent
   holds an approve, send or pay tool.
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
| Purchasing | 2 ✓ | purchase plan, `propose_purchase_orders` (drafts only, wait for approval), pending approvals, orders |
| Finance | 2 ✓ | P&L, VAT quarter position, 13-week cash-flow forecast, payback |
| Staff | 3 ✓ | staff, rota, rota plan (dry run), hours, payroll preview, `propose_payroll_run` (draft only, waits for approval) — no IBANs or IDs exposed |
| Customer/marketing | 4 | reviews, bilingual Instagram ideas tied to slow sellers, posting needs approval |

## Stock model

- `stock_movements` is the ledger: on hand = `SUM(qty)`.
- `stock_lots` hold the remaining quantity, unit cost and expiry of each delivery.
- Sales consume lots **first-expiry-first-out**, using only lots received before the sale and not yet expired.
- If sales exceed stock on record, the extra is booked as a *shortfall* (movement with no lot), costed at the latest
  price, and flagged as "count needed".
- Modifiers are `add` (extra shot +18 g) or `swap` (oat milk replaces all the fresh milk 1:1, whatever the drink size).

## Purchasing model

`src/domain/purchasing.ts`, all pure and tested:

- **When to reorder:** expected stock at delivery (on hand − daily usage × lead time) is at or below the reorder point.
- **How much:** enough to be back at par when the delivery arrives, rounded up to whole supplier packs.
- **Perishables:** never more than 80% of what can be used before expiry.
- **Minimum order:** if a supplier's order is below its minimum, other items from that supplier that are below
  par are topped up. If it's still below, the order is flagged for the owners to decide.
- **No duplicates:** items already on an open order are skipped.

## Staff model

- **Rota:** `src/domain/rota.ts`, all pure. Each day's templates are filled closing shift first, by the eligible
  person with the fewest hours that week. Eligible means employed that day, not on their rest day, not already on a
  shift that day, and under their weekly cap. Whatever is left is a gap.
- **Payroll:** `src/domain/payroll.ts`, also pure. The hourly basic wage is basic × 12 / 365 / 8.
- **Every rate is a setting** (`max_daily_hours`, `overtime_premium`, `night_overtime_premium`, `payroll_day_divisor`,
  `gratuity_days_per_year`, `shift_templates`). They follow common UAE practice; confirm with your accountant or PRO.
- **Not covered yet:** sick-leave pay tiers and annual-leave accrual. Those days are recorded and paid in full.

## Money model

- **Menu prices include VAT.** Per line: VAT = total × 5/105, rounded to the fils.
- **Rent:** 15% of net ex-VAT sales, only from `rent_start_date` (2026-11-01).
- **Fixed monthly costs** are spread over the 8th→7th business month with cumulative rounding, so the daily shares
  add up to exactly the monthly amount. The machine lease has `end_date` 2026-12-31.
- **Payback:** cumulative operating profit since 8 Oct 2026 vs AED 160,000, with a target of 7 Oct 2027.
  - The projection uses the trailing 28-day run-rate.
  - Days before rent started are charged rent in the projection, so the rent-free opening doesn't flatter it.

## Phase plan

1. **Done:** inventory + sales from a Foodics CSV, P&L core, read-only agents, daily/weekly reports, dashboard.
   Email delivery, guided setup.
2. **Done: purchasing and finance.**
   - Reorder-point PO drafts: lead time, pack rounding, shelf-life cap, minimum-order top-up, no duplicates.
   - Hourly check plus one after the nightly import; owners are emailed when approval is needed.
   - Approvals in the dashboard (CSRF-protected) and the CLI.
   - Approved POs are emailed to the supplier, or prepared for manual send.
   - Receiving books stock into lots at PO prices; input VAT is tracked.
   - Finance agent, VAT quarter position, 13-week cash-flow forecast.
   - The Sunday report adds VAT, the cash outlook and pending approvals.
   - Later: approval by WhatsApp buttons, once WhatsApp is set up.
3. **Done: staff.**
   - Staff packages, a Monday–Sunday rota auto-filled from opening and closing shift templates.
   - The rota respects rest days and weekly caps, never double-books, and flags gaps.
   - Shift status: worked, absent, sick or leave.
   - Payroll for the 8th:
     - prorating for joiners and leavers
     - daily overtime at +25%, and +50% between 22:00 and 04:00
     - unpaid absence at (basic + allowances) / 30
     - adjustments (bonuses, deductions)
   - Payroll is an approval action. The executor writes the payment sheet; an owner marks it paid.
   - A pending run is recalculated in place when inputs change.
   - The P&L swaps the placeholder salary line for real packages plus an end-of-service gratuity accrual
     (21 days' basic a year). Variable pay is booked when payroll is approved.
4. **Customer/marketing:** Google Business Profile reviews, Instagram ideas for slow sellers.
5. **Live connections:**
   - Foodics API/webhooks as a `SalesSource`, VaultsPay settlements as a `PaymentsSource` for card reconciliation.
   - Litestream backups, Docker deploy.
