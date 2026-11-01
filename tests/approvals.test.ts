import { describe, expect, it } from "vitest";
import { ApprovalError, approveAndExecute, decideAction, executeAction, getAction, markPurchaseOrderSent, receivePurchaseOrder, type SupplierSender } from "../src/domain/approvals.js";
import { vatPosition } from "../src/domain/finance.js";
import { getPurchaseOrder, proposePurchaseOrders } from "../src/domain/purchasing.js";
import { freshDb, stock } from "./helpers.js";

function setup() {
  const db = freshDb();
  db.prepare("UPDATE suppliers SET email = 'orders@goldbox.example' WHERE name = 'Goldbox'").run();
  const created = proposePurchaseOrders(db, "2026-11-01", "purchasing-agent");
  const goldbox = created.find((c) => c.order.supplierName === "Goldbox")!;
  const biru = created.find((c) => c.order.supplierName === "Biru")!;
  return { db, goldbox, biru };
}

const emailed: { to: string | null; subject: string; text: string }[] = [];
const emailSender: SupplierSender = { async send(to, subject, text) { if (!to.email) return "manual"; emailed.push({ to: to.email, subject, text }); return "email"; } };
const NOW = new Date("2026-11-01T10:00:00Z");

describe("approval state machine", () => {
  it("approve → execute emails the supplier and records who approved", async () => {
    const { db, goldbox } = setup();
    decideAction(db, goldbox.actionId, 1, "approve");
    const a = await executeAction(db, goldbox.actionId, emailSender, NOW);
    expect(a).toMatchObject({ status: "executed", decidedBy: "Partner 1" });
    expect(a.result).toMatch(/emailed to Goldbox/);
    const po = getPurchaseOrder(db, goldbox.poId)!;
    expect(po).toMatchObject({ status: "sent", sentVia: "email", expectedAt: "2026-11-04" }); // Goldbox lead time 3 days
    const mail = emailed.at(-1)!;
    expect(mail.to).toBe("orders@goldbox.example");
    expect(mail.subject).toContain(po.number);
    for (const l of po.lines) expect(mail.text).toContain(`${l.packs} × ${l.packDescription}`);
  });

  it("without a supplier email the order is prepared for an owner to send, then marked sent", async () => {
    const { db, biru } = setup();
    const a = await approveAndExecute(db, biru.actionId, 2, emailSender);
    expect(a.status).toBe("executed");
    expect(a.result).toMatch(/yourself/);
    expect(getPurchaseOrder(db, biru.poId)).toMatchObject({ status: "approved", sentVia: "manual" });
    expect(getPurchaseOrder(db, biru.poId)!.message).toContain("LW-PO-");
    markPurchaseOrderSent(db, biru.poId);
    expect(getPurchaseOrder(db, biru.poId)!.status).toBe("sent");
    expect(() => markPurchaseOrderSent(db, biru.poId)).toThrow(ApprovalError);
  });

  it("can't be approved twice (double click / two owners at once)", async () => {
    const { db, goldbox } = setup();
    await approveAndExecute(db, goldbox.actionId, 1, emailSender);
    const before = emailed.length;
    await expect(approveAndExecute(db, goldbox.actionId, 3, emailSender)).rejects.toThrow(/already executed/);
    expect(() => decideAction(db, goldbox.actionId, 3, "reject")).toThrow(ApprovalError);
    expect(emailed.length).toBe(before);
  });

  it("can't execute without approval, or after rejection", async () => {
    const { db, goldbox } = setup();
    await expect(executeAction(db, goldbox.actionId, emailSender)).rejects.toThrow(/only approved/);
    decideAction(db, goldbox.actionId, 4, "reject", "too expensive");
    expect(getPurchaseOrder(db, goldbox.poId)!.status).toBe("cancelled");
    await expect(executeAction(db, goldbox.actionId, emailSender)).rejects.toThrow(ApprovalError);
    expect(getAction(db, goldbox.actionId)).toMatchObject({ status: "rejected", decidedBy: "Partner 4", result: "too expensive" });
  });

  it("only owners can decide", () => {
    const { db, goldbox } = setup();
    expect(() => decideAction(db, goldbox.actionId, 999, "approve")).toThrow(/Only an owner/);
  });

  it("a failed send marks the action failed and the order stays approved", async () => {
    const { db, goldbox } = setup();
    const broken: SupplierSender = { async send() { throw new Error("SMTP down"); } };
    const a = await approveAndExecute(db, goldbox.actionId, 1, broken);
    expect(a).toMatchObject({ status: "failed", result: "SMTP down" });
    expect(getPurchaseOrder(db, goldbox.poId)!.status).toBe("approved");
  });
});

describe("receiving a purchase order", () => {
  it("books stock in at the order's pack prices, with input VAT", async () => {
    const { db, goldbox } = setup();
    await approveAndExecute(db, goldbox.actionId, 1, emailSender);
    const po = getPurchaseOrder(db, goldbox.poId)!;
    const cups = po.lines.find((l) => l.packDescription.includes("12oz"))!;
    const r = receivePurchaseOrder(db, po.id, "2026-11-03T09:00:00");
    expect(r.totalFils).toBe(po.totalFils);
    expect(stock(db, "cup_12oz")).toBe(cups.packs * cups.packQty);
    const lot = db.prepare("SELECT unit_cost, po_id FROM stock_lots WHERE po_id = ? AND ingredient_id = ?").get(po.id, cups.ingredientId) as any;
    expect(lot.unit_cost).toBeCloseTo(cups.priceFils / cups.packQty);
    expect(getPurchaseOrder(db, po.id)).toMatchObject({ status: "received", receivedAt: "2026-11-03T09:00:00" });
    expect(vatPosition(db, "2026-11-03").inputVatFils).toBe(Math.round(po.totalFils * 0.05));
    expect(() => receivePurchaseOrder(db, po.id, "2026-11-03T10:00:00")).toThrow(/only approved or sent/);
  });

  it("handles short deliveries", async () => {
    const { db, goldbox } = setup();
    await approveAndExecute(db, goldbox.actionId, 1, emailSender);
    const po = getPurchaseOrder(db, goldbox.poId)!;
    const [first, ...rest] = po.lines;
    const r = receivePurchaseOrder(db, po.id, "2026-11-03T09:00:00", { [first.id]: 1, ...Object.fromEntries(rest.map((l) => [l.id, 0])) });
    expect(r.totalFils).toBe(first.priceFils);
    expect(getPurchaseOrder(db, po.id)!.lines[0].receivedPacks).toBe(1);
  });

  it("can't receive an order that was never approved", () => {
    const { db, goldbox } = setup();
    expect(() => receivePurchaseOrder(db, goldbox.poId, "2026-11-03T09:00:00")).toThrow(ApprovalError);
  });
});
