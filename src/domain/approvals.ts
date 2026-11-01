/**
 * Human-in-the-loop approvals.
 *
 * Agents can only create `actions` in status pending_approval. Only an owner (dashboard or CLI) can move one to
 * approved or rejected, and only this module's executor (plain code, no LLM) carries out an approved action.
 *
 *   pending_approval ──approve(owner)──▶ approved ──execute──▶ executed | failed
 *          └────────────reject(owner)──▶ rejected
 *
 * Every transition is a conditional UPDATE (… WHERE status = expected), so a double-click or two owners approving
 * at the same moment can't execute an action twice.
 */
import type { DB } from "../db/index.js";
import { getSetting } from "../db/index.js";
import { config, emailConfigured } from "../config.js";
import { EmailNotifier } from "../integrations/notifiers/email.js";
import { receiveStock } from "./inventory.js";
import { todayInDubai } from "./periods.js";
import { composePurchaseOrderMessage, expectedDelivery, getPurchaseOrder, poNumber } from "./purchasing.js";

export type ActionStatus = "pending_approval" | "approved" | "rejected" | "executed" | "failed";

export interface ActionView {
  id: number;
  type: string;
  payload: any;
  summary: string;
  amountFils: number | null;
  status: ActionStatus;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  result: string | null;
}

export class ApprovalError extends Error {}

const view = (r: any): ActionView => ({
  id: r.id, type: r.type, payload: JSON.parse(r.payload), summary: r.summary, amountFils: r.amount_fils, status: r.status,
  proposedBy: r.proposed_by, proposedAt: r.proposed_at, decidedBy: r.owner_name ?? null, decidedAt: r.decided_at,
  executedAt: r.executed_at, result: r.result,
});

const SELECT = `SELECT a.*, o.name AS owner_name FROM actions a LEFT JOIN owners o ON o.id = a.decided_by`;

export function getAction(db: DB, id: number): ActionView | null {
  const r = db.prepare(`${SELECT} WHERE a.id = ?`).get(id);
  return r ? view(r) : null;
}

export function listActions(db: DB, statuses?: ActionStatus[], limit = 50): ActionView[] {
  const where = statuses?.length ? `WHERE a.status IN (${statuses.map(() => "?").join(",")})` : "";
  return (db.prepare(`${SELECT} ${where} ORDER BY a.id DESC LIMIT ?`).all(...(statuses ?? []), limit) as any[]).map(view);
}

export const pendingCount = (db: DB): number => (db.prepare("SELECT COUNT(*) n FROM actions WHERE status = 'pending_approval'").get() as any).n;

export function decideAction(db: DB, actionId: number, ownerId: number, decision: "approve" | "reject", note?: string, now = new Date().toISOString()): ActionView {
  const owner = db.prepare("SELECT id FROM owners WHERE id = ?").get(ownerId);
  if (!owner) throw new ApprovalError("Only an owner can approve or reject.");
  const next = decision === "approve" ? "approved" : "rejected";
  const r = db
    .prepare(`UPDATE actions SET status = ?, decided_by = ?, decided_at = ?, result = COALESCE(?, result) WHERE id = ? AND status = 'pending_approval'`)
    .run(next, ownerId, now, note ?? null, actionId);
  if (r.changes === 0) {
    const a = getAction(db, actionId);
    throw new ApprovalError(a ? `${a.summary.split(" · ")[0]} is already ${a.status.replace("_", " ")}.` : `No action #${actionId}.`);
  }
  const a = getAction(db, actionId)!;
  if (a.type === "send_purchase_order" && next === "rejected") {
    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND status = 'pending_approval'").run(a.payload.poId);
  }
  if (a.type === "send_purchase_order" && next === "approved") {
    db.prepare("UPDATE purchase_orders SET status = 'approved' WHERE id = ? AND status = 'pending_approval'").run(a.payload.poId);
  }
  return a;
}

/** How approved supplier messages leave the building. Injectable for tests. */
export interface SupplierSender {
  send(to: { name: string; email: string | null; whatsapp: string | null }, subject: string, text: string): Promise<"email" | "manual">;
}

export const defaultSupplierSender: SupplierSender = {
  async send(to, subject, text) {
    if (to.email && emailConfigured()) {
      await new EmailNotifier(config.email).send({ to: to.email, subject, text, html: undefined });
      return "email";
    }
    // No supplier email or no SMTP: the order is ready for an owner to send by WhatsApp/phone and mark as sent.
    return "manual";
  },
};

/** Carry out an approved action. Plain code — no model involved. */
export async function executeAction(db: DB, actionId: number, sender: SupplierSender = defaultSupplierSender, now = new Date()): Promise<ActionView> {
  const claimed = db.prepare("UPDATE actions SET executed_at = ? WHERE id = ? AND status = 'approved' AND executed_at IS NULL").run(now.toISOString(), actionId);
  if (claimed.changes === 0) {
    const a = getAction(db, actionId);
    throw new ApprovalError(a ? `Action #${actionId} is ${a.status.replace("_", " ")}${a.executedAt ? " and already executed" : ""}; only approved actions can be executed.` : `No action #${actionId}.`);
  }
  const a = getAction(db, actionId)!;
  try {
    let result: string;
    if (a.type === "send_purchase_order") {
      const po = getPurchaseOrder(db, a.payload.poId);
      if (!po) throw new Error(`Purchase order ${a.payload.poId} not found`);
      const lead = (db.prepare("SELECT lead_time_days FROM suppliers WHERE id = ?").get(po.supplierId) as any).lead_time_days;
      const today = todayInDubai(now);
      const due = expectedDelivery(today, lead);
      const msg = composePurchaseOrderMessage(po, getSetting(db, "kiosk_address"), due);
      const via = await sender.send({ name: po.supplier, email: po.supplierEmail, whatsapp: po.supplierWhatsapp }, msg.subject, msg.text);
      if (via === "email") {
        db.prepare("UPDATE purchase_orders SET status = 'sent', message = ?, sent_via = 'email', sent_at = ?, expected_at = ? WHERE id = ?").run(msg.text, now.toISOString(), due, po.id);
        result = `${po.number} emailed to ${po.supplier} (${po.supplierEmail}); expected ${due}`;
      } else {
        db.prepare("UPDATE purchase_orders SET message = ?, sent_via = 'manual', expected_at = ? WHERE id = ?").run(msg.text, due, po.id);
        const why = po.supplierEmail ? "email sending isn't set up yet (SMTP)" : `there's no email on record for ${po.supplier}`;
        result = `${po.number} approved — ${why}, so send the message to ${po.supplier} yourself (WhatsApp/phone) and mark it sent`;
      }
    } else {
      throw new Error(`No executor for action type "${a.type}"`);
    }
    db.prepare("UPDATE actions SET status = 'executed', result = ? WHERE id = ?").run(result, actionId);
  } catch (e) {
    db.prepare("UPDATE actions SET status = 'failed', result = ? WHERE id = ?").run((e as Error).message, actionId);
  }
  return getAction(db, actionId)!;
}

export async function approveAndExecute(db: DB, actionId: number, ownerId: number, sender: SupplierSender = defaultSupplierSender): Promise<ActionView> {
  decideAction(db, actionId, ownerId, "approve");
  return executeAction(db, actionId, sender);
}

/** Owner confirms an order sent by hand (WhatsApp/phone). */
export function markPurchaseOrderSent(db: DB, poId: number, now = new Date().toISOString()): void {
  const r = db.prepare("UPDATE purchase_orders SET status = 'sent', sent_at = ?, sent_via = COALESCE(sent_via, 'manual') WHERE id = ? AND status = 'approved'").run(now, poId);
  if (r.changes === 0) throw new ApprovalError(`${poNumber(poId)} must be approved (and not yet sent) to mark it sent.`);
}

/**
 * Book a delivery into stock at the order's prices. `receivedPacks` maps po_line id → packs actually delivered
 * (defaults to what was ordered). Lots get expiry from each ingredient's shelf life.
 */
export function receivePurchaseOrder(db: DB, poId: number, at: string, receivedPacks: Record<number, number> = {}): { lines: number; totalFils: number; vatFils: number } {
  const po = getPurchaseOrder(db, poId);
  if (!po) throw new ApprovalError(`No purchase order ${poId}`);
  if (po.status !== "sent" && po.status !== "approved") throw new ApprovalError(`${po.number} is ${po.status.replace("_", " ")}; only approved or sent orders can be received.`);
  let total = 0;
  const vatRate = Number(getSetting(db, "vat_rate"));
  const tx = db.transaction(() => {
    for (const l of po.lines) {
      const packs = receivedPacks[l.id] ?? l.packs;
      if (packs < 0) throw new ApprovalError("Received packs can't be negative");
      db.prepare("UPDATE po_lines SET received_packs = ? WHERE id = ?").run(packs, l.id);
      if (packs === 0) continue;
      receiveStock(db, { ingredientId: l.ingredientId, qty: packs * l.packQty, unitCost: l.priceFils / l.packQty, receivedAt: at, supplierId: po.supplierId, poId });
      total += packs * l.priceFils;
    }
    db.prepare("UPDATE purchase_orders SET status = 'received', received_at = ?, total_fils = ?, vat_fils = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(
      at, total, Math.round(total * vatRate), at, poId,
    );
  });
  tx();
  return { lines: po.lines.length, totalFils: total, vatFils: Math.round(total * vatRate) };
}
