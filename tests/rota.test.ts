import { describe, expect, it } from "vitest";
import { generateRota, nightMinutes, rotaWarnings, shiftMinutes, spanMinutes, type ShiftTemplate } from "../src/domain/rota.js";

const T: ShiftTemplate[] = [
  { code: "open", label: "Opening", start: "10:00", end: "19:00", break: 60 },
  { code: "close", label: "Closing", start: "13:00", end: "22:00", break: 60 },
];
const WEEK = "2026-11-02"; // Monday
const person = (id: number, name: string, restDay: number, maxWeeklyHours = 48, startDate = "2026-10-01", endDate: string | null = null) => ({ id, name, restDay, maxWeeklyHours, startDate, endDate });

describe("shift hours", () => {
  it("excludes the break", () => expect(shiftMinutes("10:00", "19:00", 60)).toBe(8 * 60));
  it("handles shifts past midnight", () => {
    expect(spanMinutes("18:00", "02:00")).toBe(8 * 60);
    expect(shiftMinutes("18:00", "02:00", 30)).toBe(7.5 * 60);
  });
  it("counts minutes between 22:00 and 04:00", () => {
    expect(nightMinutes("13:00", "22:00")).toBe(0);
    expect(nightMinutes("14:00", "23:30")).toBe(90);
    expect(nightMinutes("20:00", "05:00")).toBe(6 * 60);
  });
  it("rejects bad times", () => expect(() => shiftMinutes("9am", "17:00", 0)).toThrow(/HH:MM/));
});

describe("generateRota", () => {
  it("two people, two shifts a day: rest days respected, 48 h each, one gap per rest day", () => {
    const { shifts, gaps } = generateRota(WEEK, [person(1, "Aisha", 5), person(2, "Rahul", 2)], T);
    const hours = (id: number) => shifts.filter((s) => s.staffId === id).length * 8;
    expect(hours(1)).toBe(48);
    expect(hours(2)).toBe(48);
    expect(shifts.some((s) => s.staffId === 1 && s.date === "2026-11-06")).toBe(false); // Aisha rests Friday
    expect(shifts.some((s) => s.staffId === 2 && s.date === "2026-11-03")).toBe(false); // Rahul rests Tuesday
    expect(gaps.map((g) => [g.date, g.template])).toEqual([["2026-11-03", "open"], ["2026-11-06", "open"]]);
  });

  it("never puts one person on both shifts of a day", () => {
    const { shifts } = generateRota(WEEK, [person(1, "Aisha", 5)], T);
    const days = shifts.map((s) => s.date);
    expect(new Set(days).size).toBe(days.length);
  });

  it("fills the closing shift first (evenings are busiest)", () => {
    const { shifts, gaps } = generateRota(WEEK, [person(1, "Solo", 0)], T);
    expect(shifts.every((s) => s.template === "close")).toBe(true);
    expect(gaps.filter((g) => g.template === "open")).toHaveLength(7);
  });

  it("respects a part-timer's weekly cap and covers gaps with them", () => {
    const { shifts, gaps } = generateRota(WEEK, [person(1, "Aisha", 5), person(2, "Rahul", 2), person(3, "Sara", 1, 24)], T);
    expect(shifts.filter((s) => s.staffId === 3).length * 8).toBeLessThanOrEqual(24);
    expect(gaps).toHaveLength(0);
  });

  it("skips people before their start date or after their end date", () => {
    const { shifts } = generateRota(WEEK, [person(1, "New", 6, 48, "2026-11-05"), person(2, "Leaving", 6, 48, "2026-10-01", "2026-11-03")], T);
    expect(shifts.filter((s) => s.staffId === 1).every((s) => s.date >= "2026-11-05")).toBe(true);
    expect(shifts.filter((s) => s.staffId === 2).every((s) => s.date <= "2026-11-03")).toBe(true);
  });

  it("keeps existing shifts and counts their hours", () => {
    const existing = [{ date: WEEK, staffId: 1, template: "close", start: "13:00", end: "22:00", breakMinutes: 60 }];
    const { shifts } = generateRota(WEEK, [person(1, "Aisha", 5), person(2, "Rahul", 2)], T, existing);
    expect(shifts.some((s) => s.date === WEEK && s.template === "close")).toBe(false);
    expect(shifts.filter((s) => s.staffId === 1).length).toBe(5); // 1 existing + 5 new = 48 h
  });
});

describe("rotaWarnings", () => {
  const staff = [{ id: 1, name: "Aisha", maxWeeklyHours: 48 }];
  it("flags a double shift, the weekly cap and a missing rest day", () => {
    const shifts = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${2 + i}`, staffId: 1, template: "close", start: "13:00", end: "22:00", breakMinutes: 60 }));
    shifts.push({ date: "2026-11-02", staffId: 1, template: "open", start: "10:00", end: "19:00", breakMinutes: 60 });
    const w = rotaWarnings(shifts, staff).map((x) => x.message).join(" | ");
    expect(w).toMatch(/16\.0 h on 2026-11-02/);
    expect(w).toMatch(/64\.0 h this week/);
    expect(w).toMatch(/no rest day/);
  });
  it("no warnings for a normal week", () => {
    const shifts = Array.from({ length: 6 }, (_, i) => ({ date: `2026-11-0${2 + i}`, staffId: 1, template: "close", start: "13:00", end: "22:00", breakMinutes: 60 }));
    expect(rotaWarnings(shifts, staff)).toEqual([]);
  });
});
