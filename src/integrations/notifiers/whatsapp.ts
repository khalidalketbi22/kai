/**
 * WhatsApp Cloud API (Meta) notifier.
 *
 * Business-initiated messages (our 9pm summary) must use a pre-approved template unless the owner has messaged
 * the business number in the last 24h. So mode 'template' (default) sends the template with short params and a
 * dashboard link; mode 'text' sends the full summary as free text (works only inside the 24h window).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/template-messages
 */
import type { Notifier, OutboundMessage } from "../ports.js";

export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  apiVersion: string;
  mode: "template" | "text";
  fetchImpl?: typeof fetch;
}

/** Meta rejects template params containing newlines, tabs or more than 4 consecutive spaces. */
export const sanitizeTemplateParam = (s: string) => s.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, "   ").slice(0, 1000);

export class WhatsAppNotifier implements Notifier {
  readonly channel = "whatsapp" as const;
  constructor(private readonly o: WhatsAppOptions) {}

  buildPayload(msg: OutboundMessage): Record<string, unknown> {
    const to = msg.to.replace(/[^0-9]/g, "");
    if (this.o.mode === "template" && msg.template) {
      return {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: msg.template.name,
          language: { code: msg.template.language },
          components: [{ type: "body", parameters: msg.template.params.map((p) => ({ type: "text", text: sanitizeTemplateParam(p) })) }],
        },
      };
    }
    return { messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body: msg.text.slice(0, 4096) } };
  }

  async send(msg: OutboundMessage): Promise<void> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`https://graph.facebook.com/${this.o.apiVersion}/${this.o.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(this.buildPayload(msg)),
    });
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  }
}
