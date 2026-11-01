/** Money helpers. All amounts are integer fils (1 AED = 100 fils). */

export const aedToFils = (aed: number): number => Math.round(aed * 100);

/** Parse a POS money string like "24.00", "1,250.50" or "AED 24" into fils. */
export function parseAedToFils(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return 0;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`Not a money value: "${raw}"`);
  return aedToFils(n);
}

export function formatAed(fils: number, opts: { decimals?: 0 | 2 } = {}): string {
  const d = opts.decimals ?? 2;
  const v = fils / 100;
  return `AED ${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/**
 * Split a VAT-inclusive amount into VAT and net.
 * UAE VAT is 5%, so VAT = incl × 5/105. Rounded half-up to the nearest fils.
 */
export function splitVatInclusive(inclFils: number, vatRate = 0.05): { vatFils: number; netExVatFils: number } {
  const vatFils = Math.round((inclFils * vatRate) / (1 + vatRate));
  return { vatFils, netExVatFils: inclFils - vatFils };
}

export const pct = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
