import { describe, expect, it } from "vitest";
import { isOutsideWarmingSendWindow } from "./warmingSendWindow.ts";

// Israel is UTC+3 in October (IDT) and UTC+2 in January (IST).
const ilSummer = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00+03:00`);
const ilWinter = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00+02:00`);

describe("isOutsideWarmingSendWindow", () => {
  it("holds openers at midnight, when the daily cap resets", () => {
    expect(isOutsideWarmingSendWindow(ilSummer("00:00"))).toBe(true);
    expect(isOutsideWarmingSendWindow(ilSummer("00:15"))).toBe(true);
  });

  it("holds openers through the night and early morning", () => {
    expect(isOutsideWarmingSendWindow(ilSummer("03:30"))).toBe(true);
    expect(isOutsideWarmingSendWindow(ilSummer("08:59"))).toBe(true);
  });

  it("sends from 09:00 until just before 20:00", () => {
    expect(isOutsideWarmingSendWindow(ilSummer("09:00"))).toBe(false);
    expect(isOutsideWarmingSendWindow(ilSummer("14:43"))).toBe(false);
    expect(isOutsideWarmingSendWindow(ilSummer("19:59"))).toBe(false);
  });

  it("holds openers from 20:00", () => {
    expect(isOutsideWarmingSendWindow(ilSummer("20:00"))).toBe(true);
    expect(isOutsideWarmingSendWindow(ilSummer("23:59"))).toBe(true);
  });

  it("uses Israel time in winter too, not a fixed UTC offset", () => {
    expect(isOutsideWarmingSendWindow(ilWinter("08:30"))).toBe(true);
    expect(isOutsideWarmingSendWindow(ilWinter("09:00"))).toBe(false);
    expect(isOutsideWarmingSendWindow(ilWinter("20:00"))).toBe(true);
  });
});
