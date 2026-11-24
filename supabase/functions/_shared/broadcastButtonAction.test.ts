import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import {
  applyConversationOptOut,
  type ResolvedButtonAction,
  resolveBroadcastButtonAction,
  sendBroadcastButtonReply,
} from "./broadcastButtonAction.ts";
import type { SendResult } from "./whatsappSend.ts";

const YES_REPLY = "הנה זה 👇\n\nhttps://tinyurl.com/244ysxf7";
const STOP_REPLY = "בסדר גמור, הסרתי אותך ולא נשלח יותר הודעות. בהצלחה 🙏";
const BF_ACTIONS = {
  yes: { match: ["כן, שלחו לי"], reply: YES_REPLY },
  stop: { match: ["לא, הסירו אותי"], reply: STOP_REPLY, optout: true },
};

const NOW = new Date("2026-11-25T10:00:00Z");
const SENT_RECENTLY = "2026-11-25T08:00:00Z";

interface Op {
  table: string;
  op: "select" | "update" | "insert";
  payload?: unknown;
  filters: Array<[string, unknown]>;
}

/** Minimal chainable stub of the supabase-js calls these functions make. */
function fakeAdmin(rows: {
  latest?: Record<string, unknown> | null;
  template?: Record<string, unknown> | null;
  conversation?: Record<string, unknown> | null;
  lastOutbound?: Record<string, unknown> | null;
  optOuts?: Array<Record<string, unknown>>;
}) {
  const ops: Op[] = [];
  const single = (table: string) => {
    switch (table) {
      case "scheduled_messages": return rows.latest ?? null;
      case "broadcast_templates": return rows.template ?? null;
      case "conversations": return rows.conversation ?? null;
      case "messages": return rows.lastOutbound ?? null;
      default: return null;
    }
  };
  const admin = {
    from(table: string) {
      const op: Op = { table, op: "select", filters: [] };
      ops.push(op);
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (col: string, val: unknown) => { op.filters.push([col, val]); return q; },
        not: () => q,
        order: () => q,
        limit: () => q,
        update: (payload: unknown) => { op.op = "update"; op.payload = payload; return q; },
        insert: (payload: unknown) => { op.op = "insert"; op.payload = payload; return q; },
        maybeSingle: () => Promise.resolve({ data: single(table), error: null }),
        single: () => Promise.resolve({ data: { id: "row-1" }, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === "opt_outs" && op.op === "select" ? rows.optOuts ?? [] : null, error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { admin, ops };
}

const okSend = () =>
  vi.fn(async (): Promise<SendResult> => ({ ok: true, metaMessageId: "wamid.OUT", attempts: 1, status: 200 }));

function resolved(name: "yes" | "stop"): ResolvedButtonAction {
  return {
    templateName: "bf_pre_affiliate_nov",
    broadcastId: "b-1",
    actionName: name,
    action: name === "yes"
      ? { match: BF_ACTIONS.yes.match, reply: YES_REPLY, optout: false }
      : { match: BF_ACTIONS.stop.match, reply: STOP_REPLY, optout: true },
  };
}

const CREDS = { apiUrl: "https://example.invalid", accessToken: "t", phoneNumberId: "p" };

describe("resolveBroadcastButtonAction", () => {
  const latest = {
    template_name: "bf_pre_affiliate_nov",
    template_language: "he",
    sent_at: SENT_RECENTLY,
    broadcast_id: "b-1",
  };

  it("resolves the yes button of the attributed broadcast template", async () => {
    const { admin, ops } = fakeAdmin({ latest, template: { button_actions: BF_ACTIONS } });
    const r = await resolveBroadcastButtonAction(admin, {
      agentId: "a-1",
      conversationId: "c-1",
      reply: { text: "כן, שלחו לי", payload: "כן, שלחו לי" },
      contextDays: 14,
      now: NOW,
    });
    expect(r?.actionName).toBe("yes");
    expect(r?.action.reply).toBe(YES_REPLY);
    const tpl = ops.find((o) => o.table === "broadcast_templates");
    expect(tpl?.filters).toEqual([["agent_id", "a-1"], ["name", "bf_pre_affiliate_nov"], ["language", "he"]]);
  });

  it("resolves the stop button as an opt-out action", async () => {
    const { admin } = fakeAdmin({ latest, template: { button_actions: BF_ACTIONS } });
    const r = await resolveBroadcastButtonAction(admin, {
      agentId: "a-1",
      conversationId: "c-1",
      reply: { text: "לא, הסירו אותי", payload: null },
      contextDays: 14,
      now: NOW,
    });
    expect(r?.actionName).toBe("stop");
    expect(r?.action.optout).toBe(true);
  });

  it("returns null (→ agent fallback) for an unconfigured button", async () => {
    const { admin } = fakeAdmin({ latest, template: { button_actions: BF_ACTIONS } });
    const r = await resolveBroadcastButtonAction(admin, {
      agentId: "a-1",
      conversationId: "c-1",
      reply: { text: "ספרו לי עוד", payload: null },
      contextDays: 14,
      now: NOW,
    });
    expect(r).toBeNull();
  });

  it("returns null when the template has no button_actions", async () => {
    const { admin } = fakeAdmin({ latest, template: { button_actions: null } });
    expect(
      await resolveBroadcastButtonAction(admin, {
        agentId: "a-1", conversationId: "c-1", reply: { text: "כן, שלחו לי", payload: null }, contextDays: 14, now: NOW,
      }),
    ).toBeNull();
  });

  it("returns null when the latest sent template is not a broadcast", async () => {
    const { admin } = fakeAdmin({ latest: { ...latest, broadcast_id: null }, template: { button_actions: BF_ACTIONS } });
    expect(
      await resolveBroadcastButtonAction(admin, {
        agentId: "a-1", conversationId: "c-1", reply: { text: "כן, שלחו לי", payload: null }, contextDays: 14, now: NOW,
      }),
    ).toBeNull();
  });

  it("returns null when the broadcast is older than warming_context_days", async () => {
    const { admin } = fakeAdmin({
      latest: { ...latest, sent_at: "2026-10-01T08:00:00Z" },
      template: { button_actions: BF_ACTIONS },
    });
    expect(
      await resolveBroadcastButtonAction(admin, {
        agentId: "a-1", conversationId: "c-1", reply: { text: "כן, שלחו לי", payload: null }, contextDays: 14, now: NOW,
      }),
    ).toBeNull();
  });
});

describe("sendBroadcastButtonReply — yes path", () => {
  it("sends the configured reply and records it as an outbound message", async () => {
    const { admin, ops } = fakeAdmin({ conversation: { status: "active", current_tag: null, manual_mode_since: null } });
    const send = okSend();
    const out = await sendBroadcastButtonReply({
      admin, agentId: "a-1", conversationId: "c-1", leadPhone: "972500000000", resolved: resolved("yes"), creds: CREDS, send,
    });
    expect(out).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "972500000000", body: YES_REPLY });
    const outbound = ops.find((o) => o.table === "messages" && o.op === "insert");
    expect(outbound?.payload).toMatchObject({
      conversation_id: "c-1",
      direction: "outbound",
      message_type: "text",
      content: YES_REPLY,
      meta_message_id: "wamid.OUT",
    });
  });

  it("does not send into a conversation in manual mode", async () => {
    const { admin } = fakeAdmin({
      conversation: { status: "active", current_tag: null, manual_mode_since: "2026-11-25T09:00:00Z" },
    });
    const send = okSend();
    const out = await sendBroadcastButtonReply({
      admin, agentId: "a-1", conversationId: "c-1", leadPhone: "972500000000", resolved: resolved("yes"), creds: CREDS, send,
    });
    expect(out).toBe("skipped_gated");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not resend on a double tap", async () => {
    const { admin } = fakeAdmin({
      conversation: { status: "active", current_tag: null, manual_mode_since: null },
      lastOutbound: { content: YES_REPLY },
    });
    const send = okSend();
    const out = await sendBroadcastButtonReply({
      admin, agentId: "a-1", conversationId: "c-1", leadPhone: "972500000000", resolved: resolved("yes"), creds: CREDS, send,
    });
    expect(out).toBe("skipped_duplicate");
    expect(send).not.toHaveBeenCalled();
  });

  it("DLQs a failed send with a replayable payload", async () => {
    const { admin, ops } = fakeAdmin({ conversation: { status: "active", current_tag: null, manual_mode_since: null } });
    const send = vi.fn(async (): Promise<SendResult> => ({
      ok: false, status: 500, errorBody: "boom", attempts: 3, terminal: false,
    }));
    const out = await sendBroadcastButtonReply({
      admin, agentId: "a-1", conversationId: "c-1", leadPhone: "972500000000", resolved: resolved("yes"), creds: CREDS, send,
    });
    expect(out).toBe("send_failed");
    const dlq = ops.find((o) => o.table === "failed_messages");
    expect(dlq?.payload).toMatchObject({ payload: { reply_text: YES_REPLY, lead_phone: "972500000000" } });
  });
});

describe("stop path", () => {
  it("applyConversationOptOut tags + pauses the conversation and adds the phone to opt_outs", async () => {
    const { admin, ops } = fakeAdmin({ optOuts: [] });
    const ok = await applyConversationOptOut(admin, {
      agentId: "a-1", conversationId: "c-1", phone: "972500000000", trigger: "button", contentPreview: "לא, הסירו אותי",
    });
    expect(ok).toBe(true);
    const conv = ops.find((o) => o.table === "conversations" && o.op === "update");
    expect(conv?.payload).toEqual({ current_tag: "opted_out", status: "paused" });
    const optOut = ops.find((o) => o.table === "opt_outs" && o.op === "insert");
    expect(optOut?.payload).toMatchObject({ lead_phone: "972500000000", reason: "whatsapp_reply" });
  });

  it("does not duplicate an existing opt_outs row", async () => {
    const { admin, ops } = fakeAdmin({ optOuts: [{ id: "x" }] });
    await applyConversationOptOut(admin, {
      agentId: "a-1", conversationId: "c-1", phone: "972500000000", trigger: "button", contentPreview: "",
    });
    expect(ops.some((o) => o.table === "opt_outs" && o.op === "insert")).toBe(false);
  });

  it("sends the opt-out confirmation even though the conversation is now paused", async () => {
    const { admin } = fakeAdmin({ conversation: { status: "paused", current_tag: "opted_out", manual_mode_since: null } });
    const send = okSend();
    const out = await sendBroadcastButtonReply({
      admin, agentId: "a-1", conversationId: "c-1", leadPhone: "972500000000", resolved: resolved("stop"), creds: CREDS, send,
    });
    expect(out).toBe("sent");
    expect(send.mock.calls[0][0]).toMatchObject({ body: STOP_REPLY });
  });
});
