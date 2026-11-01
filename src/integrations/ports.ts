/**
 * Integration ports. Phase 1 ships CSV + console/WhatsApp implementations; live Foodics API,
 * VaultsPay and email plug in behind the same interfaces later.
 */

/** A POS order normalised away from any vendor's format. Money is VAT-inclusive fils. */
export interface NormalizedOrder {
  posRef: string;
  businessDate: string; // YYYY-MM-DD
  openedAt: string;     // YYYY-MM-DDTHH:MM:SS (Asia/Dubai local time)
  orderType: string | null;
  paymentMethod: string | null;
  lines: NormalizedLine[];
}

export interface NormalizedLine {
  sku: string | null;
  productName: string;
  qty: number;
  unitPriceFils: number;   // incl. VAT and modifier prices
  lineTotalFils: number;   // incl. VAT, after line discount
  modifiers: string[];     // modifier names or codes as the POS shows them
}

export interface SalesBatch {
  source: string;          // 'foodics_csv' | 'foodics_api'
  label: string;           // file name or API window
  fingerprint: string;     // sha256 of the payload, for idempotency
  rowsTotal: number;
  rowsSkipped: number;
  warnings: string[];
  orders: NormalizedOrder[];
}

/** Anything that can produce sales: a CSV file today, the Foodics API tomorrow. */
export interface SalesSource {
  fetch(): Promise<SalesBatch>;
}

/** Card settlements (VaultsPay, later) — used to reconcile POS card sales with money received. */
export interface PaymentsSource {
  settlements(from: string, to: string): Promise<{ date: string; grossFils: number; feesFils: number; netFils: number; ref: string }[]>;
}

export interface OutboundMessage {
  to: string;                       // phone (E.164) or email
  text: string;                     // full text (used for session messages / email / console)
  template?: { name: string; language: string; params: string[] }; // WhatsApp business-initiated template
}

export interface Notifier {
  readonly channel: "whatsapp" | "email" | "console";
  send(msg: OutboundMessage): Promise<void>;
}
