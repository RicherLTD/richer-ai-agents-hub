import { describe, expect, it } from "vitest";

import {
  AGENT_BOOKING_NOTE_MARKER,
  agentBookingNote,
  classifyMoozBookingSource,
} from "./moozBookingSource.ts";

describe("classifyMoozBookingSource", () => {
  it("returns 'agent' when notes carry the bot marker", () => {
    expect(
      classifyMoozBookingSource("WhatsApp lead — conversation abc-123"),
    ).toBe("agent");
  });

  it("classifies the exact note the bot writes as 'agent' (round-trip)", () => {
    expect(classifyMoozBookingSource(agentBookingNote("conv-1"))).toBe("agent");
  });

  it("returns 'self' for null / undefined / empty notes", () => {
    expect(classifyMoozBookingSource(null)).toBe("self");
    expect(classifyMoozBookingSource(undefined)).toBe("self");
    expect(classifyMoozBookingSource("")).toBe("self");
  });

  it("returns 'self' for unrelated lead-entered notes", () => {
    expect(classifyMoozBookingSource("רוצה לקבוע לשבוע הבא")).toBe("self");
  });

  it("agentBookingNote always contains the shared marker", () => {
    expect(agentBookingNote("x")).toContain(AGENT_BOOKING_NOTE_MARKER);
  });
});
