import { describe, expect, it } from "vitest";
import { toAedView, toolHandlers } from "../src/agents/tools.js";
import { AGENTS, ORCHESTRATOR_TOOLS } from "../src/agents/definitions.js";
import { WhatsAppNotifier, sanitizeTemplateParam } from "../src/integrations/notifiers/whatsapp.js";
import { hashPin, readSession, signSession, verifyPin } from "../src/web/auth.js";
import { buildDailyReport, dailyTemplateParams, renderDailyText } from "../src/reports/reports.js";
import { parseInsights } from "../src/reports/summary.js";
import { simulateHistory } from "../src/seed/seed.js";
import { freshDb } from "./helpers.js";

describe("agent tools", () => {
  it("converts fils to AED and fractions to percentages for the model", () => {
    expect(toAedView({ netExVatFils: 258_873, grossMarginPct: 0.7881, nested: [{ costFils: 12.6 }], costsByCategory: { rent: 38_831 } })).toEqual({
      netExVatAed: 2588.73, grossMarginPct: 78.8, nested: [{ costAed: 0.13 }], costsByCategoryAed: { rent: 388.31 },
    });
  });

  it("agents only get Liwan MCP tools — no shell, file or web tools", () => {
    for (const a of Object.values(AGENTS)) for (const t of a.tools ?? []) expect(t).toMatch(/^mcp__liwan__get_/);
    for (const t of ORCHESTRATOR_TOOLS) expect(t).toMatch(/^mcp__liwan__get_/);
  });

  it("handlers return data from a seeded, simulated database", async () => {
    const db = freshDb();
    simulateHistory(db, "2026-10-08", "2026-10-14");
    const h = toolHandlers(db);
    expect((await h.get_data_freshness()).latestSalesDate).toBe("2026-10-14");
    const s = await h.get_sales_summary({ from: "2026-10-08", to: "2026-10-14" });
    expect(s.orders).toBeGreaterThan(200);
    const recipe = (await h.get_recipe({ sku: "LW-LAT" })) as any;
    expect(recipe.components.map((c: any) => [c.ingredient, c.qty])).toContainEqual(["Fresh milk", 200]);
    const report = await h.get_daily_report({ date: "2026-10-14" });
    expect(report.sales.orders).toBeGreaterThan(0);
  });
});

describe("reports", () => {
  it("daily text and WhatsApp template params are consistent", () => {
    const db = freshDb();
    simulateHistory(db, "2026-10-08", "2026-10-15");
    const r = buildDailyReport(db, "2026-10-15");
    const text = renderDailyText(r, "en");
    expect(text).toContain("daily summary · 2026-10-15");
    expect(renderDailyText(r, "ar")).toContain("الملخص اليومي");
    const params = dailyTemplateParams(r, "https://liwan.example");
    expect(params).toHaveLength(9);
    for (const p of params) expect(p).not.toMatch(/\n/);
    expect(params[2]).toBe(String(r.sales.orders));
  });

  it("splits agent insights into English and Arabic", () => {
    expect(parseInsights("- reorder milk\n---AR---\n- اطلب الحليب")).toEqual({ en: "- reorder milk", ar: "- اطلب الحليب" });
    expect(parseInsights("- only english")).toEqual({ en: "- only english", ar: "- only english" });
  });
});

describe("WhatsApp notifier", () => {
  it("builds a template message with single-line params", () => {
    const n = new WhatsAppNotifier({ token: "t", phoneNumberId: "123", apiVersion: "v21.0", mode: "template" });
    const p = n.buildPayload({ to: "+971 50 123 4567", text: "full", template: { name: "liwan_daily_summary", language: "en", params: ["a\nb", "c"] } }) as any;
    expect(p.to).toBe("971501234567");
    expect(p.template.components[0].parameters).toEqual([{ type: "text", text: "a · b" }, { type: "text", text: "c" }]);
  });

  it("text mode sends the full body", () => {
    const n = new WhatsAppNotifier({ token: "t", phoneNumberId: "123", apiVersion: "v21.0", mode: "text" });
    expect((n.buildPayload({ to: "971500000000", text: "hello" }) as any).text.body).toBe("hello");
  });

  it("posts to the Graph API and surfaces errors", async () => {
    const calls: any[] = [];
    const ok = new WhatsAppNotifier({ token: "tok", phoneNumberId: "999", apiVersion: "v21.0", mode: "text", fetchImpl: (async (url: string, init: any) => { calls.push([url, init]); return new Response("{}", { status: 200 }); }) as any });
    await ok.send({ to: "971500000000", text: "hi" });
    expect(calls[0][0]).toBe("https://graph.facebook.com/v21.0/999/messages");
    expect(calls[0][1].headers.Authorization).toBe("Bearer tok");
    const bad = new WhatsAppNotifier({ token: "t", phoneNumberId: "1", apiVersion: "v21.0", mode: "text", fetchImpl: (async () => new Response("nope", { status: 401 })) as any });
    await expect(bad.send({ to: "1", text: "x" })).rejects.toThrow(/401/);
  });

  it("sanitizes template params", () => expect(sanitizeTemplateParam("a\t\tb      c")).toBe("a · b   c"));
});

describe("dashboard auth", () => {
  it("verifies PINs", () => {
    const h = hashPin("4821");
    expect(verifyPin("4821", h)).toBe(true);
    expect(verifyPin("4822", h)).toBe(false);
    expect(verifyPin("4821", null)).toBe(false);
  });

  it("signs sessions and rejects tampering or expiry", () => {
    const tok = signSession(3, "secret", 1_000);
    expect(readSession(tok, "secret", 2_000)).toBe(3);
    expect(readSession(tok.replace(/^3/, "1"), "secret", 2_000)).toBeNull();
    expect(readSession(tok, "other", 2_000)).toBeNull();
    expect(readSession(tok, "secret", 1_000 + 31 * 86_400_000)).toBeNull();
  });
});
