/** Per-owner PIN login with an HMAC-signed session cookie. Approvals (Phase 2) need to know which owner clicked. */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DB } from "../db/index.js";

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(pin, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_DAYS = 30;

export function signSession(ownerId: number, secret: string, now = Date.now()): string {
  const payload = `${ownerId}.${now + SESSION_DAYS * 86_400_000}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function readSession(token: string | undefined, secret: string, now = Date.now()): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${id}.${exp}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < now) return null;
  return Number(id);
}

export function setOwnerPin(db: DB, ownerName: string, pin: string): void {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN must be 4–8 digits");
  const r = db.prepare("UPDATE owners SET pin_hash = ? WHERE name = ?").run(hashPin(pin), ownerName);
  if (r.changes === 0) throw new Error(`No owner named "${ownerName}"`);
}
