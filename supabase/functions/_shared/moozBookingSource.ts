/**
 * Mooz booking source classification.
 *
 * A Zoom can reach `current_tag='zoom_scheduled'` through the bot's
 * `book_meeting` tool (an agent conversion) OR through the lead booking
 * themselves on the Mooz hosted page (self-service). Downstream they look
 * identical EXCEPT for one signal: when the bot books, it stamps the Mooz
 * booking notes with a fixed marker (see moozTools.ts handleBookMeeting).
 * Self-service / advisor-completed bookings never carry it.
 *
 * This is the discriminator behind `conversations.zoom_booked_by`
 * (migration 0033). Kept pure + dependency-free so it is unit-testable, and
 * so the writer (moozTools) and the reader (mooz-webhook) share one marker
 * and can never drift apart.
 */

/** Substring the bot always writes into Mooz booking notes. The stable
 *  contract between moozTools (writer) and mooz-webhook (reader). */
export const AGENT_BOOKING_NOTE_MARKER = "WhatsApp lead";

/** The exact notes string the bot attaches when it books via the tool. */
export function agentBookingNote(conversationId: string): string {
  return `${AGENT_BOOKING_NOTE_MARKER} — conversation ${conversationId}`;
}

/**
 * Classify a Mooz `booking.created` / `booking.rescheduled` event by its
 * notes field. Returns `'agent'` when the bot's marker is present, otherwise
 * `'self'`.
 *
 * Never returns `'consent_handoff'` — that route makes no Mooz booking, so it
 * is set by the memory extractor, not here.
 */
export function classifyMoozBookingSource(
  notes: string | null | undefined,
): "agent" | "self" {
  return notes && notes.includes(AGENT_BOOKING_NOTE_MARKER) ? "agent" : "self";
}
