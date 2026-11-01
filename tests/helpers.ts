import { openDb } from "../src/db/index.js";
import { seedReferenceData } from "../src/seed/seed.js";
import { ingredientIdByCode, onHand, receiveStock } from "../src/domain/inventory.js";

export function freshDb() {
  const db = openDb(":memory:");
  seedReferenceData(db);
  return db;
}

export const H = "Order Reference,Business Date,Opened At,Status,Order Type,Product SKU,Product,Modifiers,Quantity,Unit Price,Discount Amount,Total Price,Payment Method";

export const stock = (db: ReturnType<typeof freshDb>, code: string) => onHand(db, ingredientIdByCode(db, code));

export function receive(db: ReturnType<typeof freshDb>, code: string, qty: number, unitCost: number, at: string, expiresAt?: string | null) {
  return receiveStock(db, { ingredientId: ingredientIdByCode(db, code), qty, unitCost, receivedAt: at, expiresAt });
}
