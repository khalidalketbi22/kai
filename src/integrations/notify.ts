/**
 * Fan a report out to every owner on every configured channel, logging each send:
 *   WhatsApp → owners with a phone number (when WHATSAPP_* is set)
 *   Email    → owners with an email address (when SMTP_* is set)
 *   Console  → only when neither channel is configured
 */
import type { DB } from "../db/index.js";
import { config, emailConfigured, whatsappConfigured } from "../config.js";
import { ConsoleNotifier } from "./notifiers/console.js";
import { EmailNotifier, textToEmailHtml } from "./notifiers/email.js";
import { WhatsAppNotifier } from "./notifiers/whatsapp.js";
import type { Notifier } from "./ports.js";

export function configuredNotifiers(): Notifier[] {
  const out: Notifier[] = [];
  if (whatsappConfigured()) {
    const w = config.whatsapp;
    out.push(new WhatsAppNotifier({ token: w.token, phoneNumberId: w.phoneNumberId, apiVersion: w.apiVersion, mode: w.mode }));
  }
  if (emailConfigured()) out.push(new EmailNotifier(config.email));
  return out.length ? out : [new ConsoleNotifier()];
}

export interface OwnerMessage {
  textFor: (locale: "en" | "ar") => string;
  subjectFor?: (locale: "en" | "ar") => string;
  link?: string;
  template?: { name: string; params: string[] };
}

interface OwnerRow { name: string; phone: string | null; email: string | null; locale: "en" | "ar" }

export async function notifyOwners(db: DB, msg: OwnerMessage, notifiers: Notifier[] | Notifier = configuredNotifiers()): Promise<{ sent: number; failed: number; skipped: string[] }> {
  const list = Array.isArray(notifiers) ? notifiers : [notifiers];
  const owners = db.prepare("SELECT name, phone, email, locale FROM owners ORDER BY id").all() as OwnerRow[];
  const log = db.prepare("INSERT INTO notifications (channel, recipient, body, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?)");
  let sent = 0, failed = 0;
  const skipped: string[] = [];

  for (const n of list) {
    const recipients =
      n.channel === "console" ? [{ name: "owners", to: "console", locale: "en" as const }]
      : n.channel === "whatsapp" ? owners.filter((o) => o.phone).map((o) => ({ name: o.name, to: o.phone!, locale: o.locale }))
      : owners.filter((o) => o.email).map((o) => ({ name: o.name, to: o.email!, locale: o.locale }));
    if (n.channel !== "console") {
      for (const o of owners) if (!(n.channel === "whatsapp" ? o.phone : o.email)) skipped.push(`${o.name} (no ${n.channel === "whatsapp" ? "phone" : "email"})`);
    }
    for (const r of recipients) {
      const text = msg.textFor(r.locale);
      try {
        await n.send({
          to: r.to,
          text,
          subject: msg.subjectFor?.(r.locale),
          html: n.channel === "email" ? textToEmailHtml(text, { dashboardUrl: msg.link }) : undefined,
          template: msg.template && { name: msg.template.name, language: config.whatsapp.templateLanguage, params: msg.template.params },
        });
        log.run(n.channel, r.to, text, "sent", null, new Date().toISOString());
        sent++;
      } catch (e) {
        log.run(n.channel, r.to, text, "failed", (e as Error).message, new Date().toISOString());
        console.error(`Failed to send ${n.channel} to ${r.name}: ${(e as Error).message}`);
        failed++;
      }
    }
  }
  if (skipped.length) console.warn(`Not sent to: ${skipped.join(", ")}. Add with: npm run liwan -- owner --name "…" --email … --phone …`);
  return { sent, failed, skipped };
}
