import type { Notifier, OutboundMessage } from "../ports.js";

export class ConsoleNotifier implements Notifier {
  readonly channel = "console" as const;
  async send(msg: OutboundMessage): Promise<void> {
    console.log(`\n──── message to ${msg.to} ────\n${msg.text}\n────────────────────────────`);
  }
}
