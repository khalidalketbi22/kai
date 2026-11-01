/** Fan a report out to every owner on the configured channel, logging each send. */
import type { DB } from "../db/index.js";
import { config, whatsappConfigured } from "../config.js";
import { ConsoleNotifier } from "./notifiers/console.js";
import { WhatsAppNotifier } from "./notifiers/whatsapp.js";
import type { Notifier } from "./ports.js";

export function defaultNotifier(): Notifier {
  if (whatsappConfigured()) {
    const w = config.whatsapp;
    return new WhatsAppNotifier({ token: w.token, phoneNumberId: w.phoneNumberId, apiVersion: w.apiVersion, mode: w.mode });
  }
  return new ConsoleNotifier();
}

export interface OwnerMessage {
  textFor: (locale: "en" | "ar") => string;
  template?: { name: string; params: string[] };
}

export async function notifyOwners(db: DB, msg: OwnerMessage, notifier: Notifier = defaultNotifier()): Promise<{ sent: number; failed: number }> {
  const owners = db.prepare("SELECT name, phone, email, locale FROM owners ORDER BY id").all() as any[];
  const log = db.prepare("INSERT INTO notifications (channel, recipient, body, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?)");
  let sent = 0, failed = 0;

  // On the console, print once rather than four times.
  const recipients = notifier.channel === "console" ? [{ name: "owners", phone: "console", locale: "en" }] : owners.filter((o) => o.phone);
  if (notifier.channel === "whatsapp" && recipients.length === 0) {
    console.warn("WhatsApp is configured but no owner has a phone number. Run: npm run liwan -- owner --name \"Partner 1\" --phone +9715…");
  }
  for (const o of recipients) {
    const text = msg.textFor(o.locale);
    try {
      await notifier.send({
        to: o.phone,
        text,
        template: msg.template && { name: msg.template.name, language: config.whatsapp.templateLanguage, params: msg.template.params },
      });
      log.run(notifier.channel, o.phone, text, "sent", null, new Date().toISOString());
      sent++;
    } catch (e) {
      log.run(notifier.channel, o.phone, text, "failed", (e as Error).message, new Date().toISOString());
      console.error(`Failed to notify ${o.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  return { sent, failed };
}
