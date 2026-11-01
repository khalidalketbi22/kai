import { describe, expect, it } from "vitest";
import { createApp } from "../src/web/server.js";
import { signSession } from "../src/web/auth.js";
import { config } from "../src/config.js";
import { getAction } from "../src/domain/approvals.js";
import { getPurchaseOrder, proposePurchaseOrders } from "../src/domain/purchasing.js";
import { freshDb } from "./helpers.js";

const BASE = "http://localhost:8787";
const cookie = (ownerId: number) => `sid=${signSession(ownerId, config.sessionSecret)}`;

describe("dashboard approvals", () => {
  const setup = () => {
    const db = freshDb();
    const [first] = proposePurchaseOrders(db, "2026-11-01", "test");
    const sent: string[] = [];
    const app = createApp(db, { supplierSender: { async send(to) { sent.push(to.name); return "email"; } } });
    return { db, first, app, sent };
  };

  it("requires a signed-in owner", async () => {
    const { app, first } = setup();
    const r = await app.request(`${BASE}/approvals/${first.actionId}/approve`, { method: "POST", headers: { Origin: BASE } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
  });

  it("lists pending orders and approves as the signed-in owner", async () => {
    const { db, app, first, sent } = setup();
    const page = await (await app.request(`${BASE}/approvals`, { headers: { Cookie: cookie(2) } })).text();
    expect(page).toContain(`/approvals/${first.actionId}/approve`);
    const r = await app.request(`${BASE}/approvals/${first.actionId}/approve`, { method: "POST", headers: { Cookie: cookie(2), Origin: BASE } });
    expect(r.status).toBe(302);
    expect(getAction(db, first.actionId)).toMatchObject({ status: "executed", decidedBy: "Partner 2" });
    expect(getPurchaseOrder(db, first.poId)!.status).toBe("sent");
    expect(sent).toEqual([first.order.supplierName]);
  });

  it("blocks cross-site form posts (CSRF)", async () => {
    const { db, app, first } = setup();
    const r = await app.request(`${BASE}/approvals/${first.actionId}/approve`, {
      method: "POST",
      headers: { Cookie: cookie(1), Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(r.status).toBe(403);
    expect(getAction(db, first.actionId)!.status).toBe("pending_approval");
  });

  it("shows a friendly error when approving something already decided", async () => {
    const { app, first } = setup();
    const h = { Cookie: cookie(1), Origin: BASE };
    await app.request(`${BASE}/approvals/${first.actionId}/reject`, { method: "POST", headers: h });
    const r = await app.request(`${BASE}/approvals/${first.actionId}/approve`, { method: "POST", headers: h });
    expect(r.headers.get("location")).toMatch(/error=.*rejected/);
  });

  it("renders the finance page", async () => {
    const { app } = setup();
    const html = await (await app.request(`${BASE}/finance`, { headers: { Cookie: cookie(1) } })).text();
    expect(html).toContain("Cash-flow forecast");
    expect(html).toContain("VAT this quarter");
  });
});
