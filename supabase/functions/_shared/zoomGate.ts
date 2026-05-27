// zoomGate.ts
//
// Deterministic qualification floor for the Zoom booking tools. The agent
// prompt (v15) is instructed to warm the lead and surface pain BEFORE it
// offers a meeting, but a prompt is probabilistic. This floor is the hard
// backstop: the Mooz tools refuse to pull slots / book until the lead has
// surfaced
//   - a goal      (q3_dream_change), AND
//   - a pain      (q4_blocker),      AND
//   - at least 3 of the 5 core questions.
//
// Pure + synchronous so it's trivially unit-testable. The caller (moozTools)
// reads lead_memory and hands the 5 fields in. Reads can lag the live turn
// by one extraction cycle — that's acceptable, it only ever errs toward MORE
// warming, never toward a premature booking.

import { countCoreAnswered, type CoreQuestionFields } from "./extractMemory.ts";

export interface ZoomGateResult {
  ok: boolean;
  /** Hebrew descriptions of what's still missing — fed back to Claude as the
   *  guidance in the blocking tool_result so it knows what to keep warming. */
  missing: string[];
}

/** Minimum of the 5 core questions (q1-q5) answered to clear the floor. */
export const MIN_CORE_ANSWERED = 3;

export function meetsZoomQualificationFloor(
  memory: CoreQuestionFields,
): ZoomGateResult {
  const missing: string[] = [];
  if (memory.q3_dream_change === null) {
    missing.push("מה הליד רוצה לשנות בחיים (יעד)");
  }
  if (memory.q4_blocker === null) {
    missing.push("מה עוצר אותו / הכאב האמיתי");
  }
  const answered = countCoreAnswered(memory);
  if (answered < MIN_CORE_ANSWERED) {
    missing.push(
      `לפחות ${MIN_CORE_ANSWERED} מתוך 5 שאלות החימום (כרגע ${answered})`,
    );
  }
  return { ok: missing.length === 0, missing };
}
