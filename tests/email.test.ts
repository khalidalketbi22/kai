import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { EmailNotifier, textToEmailHtml } from "../src/integrations/notifiers/email.js";
import { notifyOwners } from "../src/integrations/notify.js";
import type { Notifier, OutboundMessage } from "../src/integrations/ports.js";
import { freshDb } from "./helpers.js";

describe("email notifier", () => {
  it("sends subject, plain text (without * markers) and HTML over SMTP", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: any[] = [];
    const orig = transport.sendMail.bind(transport);
    (transport as any).sendMail = async (m: any) => { const r: any = await orig(m); sent.push(JSON.parse(r.message)); return r; };
    const n = new EmailNotifier({ host: "x", port: 465, user: "u", pass: "p", from: "The Liwan <ops@liwan.ae>", transport });
    await n.send({ to: "partner@example.com", subject: "Daily", text: "☕ Title\n\n*Sales*\nNet: AED 2,589" });
    expect(sent[0].to).toEqual([{ address: "partner@example.com", name: "" }]);
    expect(sent[0].subject).toBe("Daily");
    expect(sent[0].text).toContain("Sales\nNet: AED 2,589");
    expect(sent[0].html).toContain("<h3");
  });

  it("renders headings, bullets, links and escapes HTML", () => {
    const html = textToEmailHtml("☕ The Liwan — daily summary · 2026-11-01\n\n*Stock alerts*\n• Fresh milk <out>\n• Oat milk low\nSee https://liwan.example/stock", { dashboardUrl: "https://liwan.example" });
    expect(html).toContain('dir="ltr"');
    expect(html).toContain(">The Liwan — daily summary · 2026-11-01</h2>");
    expect(html).toMatch(/<h3[^>]*>Stock alerts/);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain("Fresh milk &lt;out&gt;");
    expect(html).toContain('<a href="https://liwan.example/stock"');
    expect(html).toContain("Open dashboard");
  });

  it("lays Arabic reports out right-to-left", () => {
    const html = textToEmailHtml("☕ الليوان — الملخص اليومي · 2026-11-01\n*المبيعات*\nصافي المبيعات", { dashboardUrl: "https://x" });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("افتح لوحة التحكم");
  });
});

class FakeNotifier implements Notifier {
  sent: OutboundMessage[] = [];
  constructor(readonly channel: "whatsapp" | "email" | "console", private fail = false) {}
  async send(m: OutboundMessage) { if (this.fail) throw new Error("boom"); this.sent.push(m); }
}

describe("notifyOwners", () => {
  it("emails owners with an email, WhatsApps owners with a phone, each in their language", async () => {
    const db = freshDb();
    db.prepare("UPDATE owners SET email = 'p1@x.com' WHERE name = 'Partner 1'").run();
    db.prepare("UPDATE owners SET email = 'p2@x.com', phone = '+971500000002' WHERE name = 'Partner 2'").run(); // Partner 2 is Arabic
    const email = new FakeNotifier("email"), wa = new FakeNotifier("whatsapp");
    const r = await notifyOwners(db, { textFor: (l) => (l === "ar" ? "مرحبا" : "hello"), subjectFor: (l) => `subj-${l}`, link: "https://d" }, [email, wa]);
    expect(r.sent).toBe(3);
    expect(email.sent.map((m) => [m.to, m.text, m.subject])).toEqual([["p1@x.com", "hello", "subj-en"], ["p2@x.com", "مرحبا", "subj-ar"]]);
    expect(email.sent[0].html).toContain("https://d");
    expect(wa.sent.map((m) => m.to)).toEqual(["+971500000002"]);
    expect(r.skipped).toContain("Partner 3 (no email)");
    expect((db.prepare("SELECT COUNT(*) n FROM notifications WHERE status = 'sent'").get() as any).n).toBe(3);
  });

  it("logs failures without stopping other recipients", async () => {
    const db = freshDb();
    db.prepare("UPDATE owners SET email = name || '@x.com'").run();
    const r = await notifyOwners(db, { textFor: () => "x" }, [new FakeNotifier("email", true)]);
    expect(r).toMatchObject({ sent: 0, failed: 4 });
    expect((db.prepare("SELECT error FROM notifications LIMIT 1").get() as any).error).toBe("boom");
  });
});

describe("setup .env merge", async () => {
  const { mergeEnv, isEmail } = await import("../src/setup.js");
  it("updates existing keys in place, keeps comments/other keys, appends new ones, quotes when needed", () => {
    const out = mergeEnv("# Liwan\nPORT=8787\nSMTP_USER=old@x.com\n", { SMTP_USER: "new@x.com", EMAIL_FROM: "The Liwan <new@x.com>" });
    expect(out).toBe('# Liwan\nPORT=8787\nSMTP_USER=new@x.com\nEMAIL_FROM="The Liwan <new@x.com>"\n');
  });
  it("works on an empty file", () => expect(mergeEnv("", { A: "1" })).toBe("A=1\n"));
  it("validates emails", () => {
    expect(isEmail("khalid@example.com")).toBe(true);
    expect(isEmail("not-an-email")).toBe(false);
  });
});
