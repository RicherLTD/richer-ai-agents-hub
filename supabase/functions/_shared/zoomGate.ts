// zoomGate.ts
//
// Deterministic qualification floor for the Zoom booking tools. The agent
// prompt warms the lead and surfaces pain/goal BEFORE offering a meeting, but
// a prompt is probabilistic. This floor is the hard backstop that stops the
// bot from booking a totally cold lead who has shared nothing.
//
// FLOOR (v3, 2026-07-07): the lead must have surfaced AT LEAST ONE of
//   - a goal  (q3_dream_change), OR
//   - a pain  (q4_blocker).
// Rationale: the business priority is the Zoom; over-warming that would lose a
// quality lead is worse than a slightly-less-warm booking. The earlier floor
// (goal AND pain AND >=3/5 questions) nagged leads with "just one more
// question" and lost them. One real qualifier is enough. An EXPLICIT booking
// request or exit-risk signal bypasses this floor entirely — handled by the
// caller (moozTools), which passes `requestedBooking` and skips the gate.
// This module only encodes the deterministic floor.
//
// Pure + synchronous so it's trivially unit-testable. Reads can lag the live
// turn by one extraction cycle — acceptable, it only ever errs toward MORE
// warming, never toward a premature booking.

import { type CoreQuestionFields } from "./extractMemory.ts";

export interface ZoomGateResult {
  ok: boolean;
  /** Hebrew descriptions of what's still missing — fed back to Claude as the
   *  guidance in the blocking tool_result so it knows what to keep warming. */
  missing: string[];
}

export function meetsZoomQualificationFloor(
  memory: CoreQuestionFields,
): ZoomGateResult {
  const hasGoal = memory.q3_dream_change !== null;
  const hasPain = memory.q4_blocker !== null;
  const missing: string[] = [];
  if (!hasGoal && !hasPain) {
    missing.push(
      "לפחות אחד מאלה: מה הליד רוצה לשנות (יעד) או מה הכי עוצר אותו (כאב)",
    );
  }
  return { ok: missing.length === 0, missing };
}
