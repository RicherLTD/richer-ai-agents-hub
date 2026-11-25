// broadcastButtonAction.ts
//
// Deterministic answer to a quick-reply tap on a broadcast template, BEFORE
// (and instead of) the AI agent. The operator configures per template, in
// broadcast_templates.button_actions, which button sends which fixed reply and
// which button is a removal request (quickReply.ts validates the shape).
//
// Attribution reuses the broadcast re-warm rule: the conversation's latest
// SENT template must carry a broadcast_id and be inside the agent's
// warming_context_days window. A tap that maps to nothing configured is NOT
// handled here — the handler treats the label as ordinary text for the agent,
// so a tap is never silently dropped.
//
// Also home of applyConversationOptOut, the single opt-out implementation
// shared by the typed "הסר" path and the "stop" button.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import { shouldRenderBroadcastRewarm } from "./broadcastRewarmBlock.ts";
import { enqueueFailedMessage } from "./dlq.ts";
import { logError } from "./logError.ts";
import {
  type ButtonActionConfig,
  type InboundButtonReply,
  matchButtonAction,
  parseButtonActions,
} from "./quickReply.ts";
import type { SendResult, SendWhatsAppTextArgs } from "./whatsappSend.ts";

const SOURCE = "whatsapp-webhook";

/** A tap resolved to a configured action on the attributed template. */
export interface ResolvedButtonAction {
  templateName: string;
  broadcastId: string;
  actionName: string;
  action: ButtonActionConfig;
}

/**
 * The configured action for this tap, or null (not a broadcast reply, outside
 * the window, template has no button_actions, or no button matched).
 */
export async function resolveBroadcastButtonAction(
  admin: SupabaseClient,
  args: {
    agentId: string;
    conversationId: string;
    reply: InboundButtonReply;
    /** agents.warming_context_days — same window as the broadcast re-warm. */
    contextDays: number;
    now?: Date;
  },
): Promise<ResolvedButtonAction | null> {
  const { data: latest, error: latestErr } = await admin
    .from("scheduled_messages")
    .select("template_name, template_language, sent_at, broadcast_id")
    .eq("conversation_id", args.conversationId)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw new Error(`scheduled_messages lookup failed: ${latestErr.message}`);
  const broadcastId = (latest?.broadcast_id as string | null | undefined) ?? null;
  const templateName = (latest?.template_name as string | null | undefined) ?? null;
  const sentAt = (latest?.sent_at as string | null | undefined) ?? null;
  if (!broadcastId || !templateName || !sentAt) return null;
  if (!shouldRenderBroadcastRewarm({ openerSentAt: sentAt, contextDays: args.contextDays }, args.now)) {
    return null;
  }

  let query = admin
    .from("broadcast_templates")
    .select("button_actions")
    .eq("agent_id", args.agentId)
    .eq("name", templateName);
  const language = (latest?.template_language as string | null | undefined) ?? null;
  if (language) query = query.eq("language", language);
  const { data: template, error: tplErr } = await query.limit(1).maybeSingle();
  if (tplErr) throw new Error(`broadcast_templates lookup failed: ${tplErr.message}`);

  const { actions, errors } = parseButtonActions(template?.button_actions ?? null);
  if (errors.length > 0) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "button_actions_invalid",
      level: "warn",
      message: `broadcast_templates.button_actions for ${templateName} has invalid entries`,
      context: { templateName, errors },
      agentId: args.agentId,
      conversationId: args.conversationId,
    });
  }
  const matched = matchButtonAction(actions, args.reply);
  if (!matched) return null;
  return { templateName, broadcastId, actionName: matched.name, action: matched.action };
}

/**
 * Opt the lead out: tag + pause the conversation (blocks this agent) and add
 * the phone to the global opt_outs list (blocks every broadcast). Returns
 * false when the conversation update failed. Never throws.
 */
export async function applyConversationOptOut(
  admin: SupabaseClient,
  args: {
    agentId: string;
    conversationId: string;
    phone: string;
    /** Why — lands in error_logs context: "text" | "button". */
    trigger: string;
    contentPreview: string;
  },
): Promise<boolean> {
  const { error: optOutErr } = await admin
    .from("conversations")
    .update({ current_tag: "opted_out", status: "paused" })
    .eq("id", args.conversationId);
  if (optOutErr) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "auto_opt_out_update_failed",
      message: optOutErr.message,
      context: { phone: args.phone, trigger: args.trigger, dbCode: optOutErr.code ?? null },
      agentId: args.agentId,
      conversationId: args.conversationId,
    });
  } else {
    await logError({
      admin,
      source: SOURCE,
      errorType: "auto_opt_out",
      level: "info",
      message: `auto opt-out triggered by inbound ${args.trigger}`,
      context: { phone: args.phone, trigger: args.trigger, content_preview: args.contentPreview.slice(0, 200) },
      agentId: args.agentId,
      conversationId: args.conversationId,
    });
  }
  // Also record the phone in the GLOBAL opt_outs suppression list. The
  // conversation tag above only blocks THIS agent's conversation; opt_outs is
  // phone-level and cross-agent, and is the list the broadcast feature checks
  // (including CSV uploads) so a "remove me" here is honored everywhere.
  // Best-effort: never let it break the opt-out acknowledgement.
  try {
    const { data: existing } = await admin
      .from("opt_outs")
      .select("id")
      .eq("lead_phone", args.phone)
      .limit(1);
    if (!existing || existing.length === 0) {
      await admin
        .from("opt_outs")
        .insert({ lead_phone: args.phone, reason: "whatsapp_reply", opted_out_at: new Date().toISOString() });
    }
  } catch (_e) {
    // opt_outs is best-effort; the conversation tag already blocks this agent.
  }
  return !optOutErr;
}

// Same set as the agent loop's BLOCKING_TAGS: never auto-send into these.
const BLOCKING_TAGS: ReadonlySet<string> = new Set(["opted_out", "requires_human", "underage"]);

export interface ButtonReplyCtx {
  admin: SupabaseClient;
  agentId: string;
  conversationId: string;
  leadPhone: string;
  resolved: ResolvedButtonAction;
  creds: { apiUrl: string; accessToken: string; phoneNumberId: string };
  /** Injected for tests; the handler passes sendWhatsAppText. */
  send: (args: SendWhatsAppTextArgs) => Promise<SendResult>;
}

export type ButtonReplyOutcome = "sent" | "skipped_gated" | "skipped_duplicate" | "send_failed";

/**
 * Send the configured fixed reply and record it like any outbound. No LLM.
 *
 * Gating: a "yes"-type reply respects the same conversation gates as the agent
 * loop (paused / blocking tag / manual mode). The opt-out confirmation is
 * always sent — the conversation was paused a moment ago by the opt-out
 * itself. Quiet hours are deliberately NOT applied: the lead just asked for
 * the link, the reply is a fixed operator-approved text, and nothing would
 * re-send it in the morning.
 *
 * Never throws.
 */
export async function sendBroadcastButtonReply(ctx: ButtonReplyCtx): Promise<ButtonReplyOutcome> {
  const { admin, resolved } = ctx;
  const body = resolved.action.reply;
  const logCtx = {
    lead_phone: ctx.leadPhone,
    template_name: resolved.templateName,
    broadcast_id: resolved.broadcastId,
    button_action: resolved.actionName,
  };
  try {
    if (!resolved.action.optout) {
      const { data: conv } = await admin
        .from("conversations")
        .select("status, current_tag, manual_mode_since")
        .eq("id", ctx.conversationId)
        .maybeSingle();
      const status = (conv?.status as string | null | undefined) ?? null;
      const tag = (conv?.current_tag as string | null | undefined) ?? null;
      const manual = (conv?.manual_mode_since as string | null | undefined) ?? null;
      if ((status !== null && status !== "active") || (tag && BLOCKING_TAGS.has(tag)) || manual) {
        await logError({
          admin,
          source: SOURCE,
          errorType: "button_action_skipped_gated",
          level: "info",
          message: `button reply not sent — status=${status ?? "null"} tag=${tag ?? "null"} manual=${manual ? "yes" : "no"}`,
          context: { ...logCtx, status, current_tag: tag, manual_mode_since: manual },
          agentId: ctx.agentId,
          conversationId: ctx.conversationId,
        });
        return "skipped_gated";
      }
    }

    // Double tap → one reply. Same guard the fallback apology uses.
    const { data: last } = await admin
      .from("messages")
      .select("content")
      .eq("conversation_id", ctx.conversationId)
      .eq("direction", "outbound")
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (((last as { content?: string | null } | null)?.content ?? "") === body) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "button_action_duplicate_skipped",
        level: "info",
        message: "button reply already the last outbound — not resent",
        context: logCtx,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
      return "skipped_duplicate";
    }

    const sent = await ctx.send({
      apiUrl: ctx.creds.apiUrl,
      accessToken: ctx.creds.accessToken,
      phoneNumberId: ctx.creds.phoneNumberId,
      to: ctx.leadPhone,
      body,
    });
    if (!sent.ok) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "button_action_send_failed",
        message: `button reply send failed status=${sent.status} attempts=${sent.attempts}`,
        context: { ...logCtx, status: sent.status, terminal: sent.terminal },
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
      // Filed as hookmyapp_send_failed — the type dlq-replay knows how to
      // replay (it re-sends reply_text to lead_phone from the agent's own
      // channel). error_logs above keeps the button-specific type.
      await enqueueFailedMessage({
        admin,
        source: SOURCE,
        errorType: "hookmyapp_send_failed",
        errorDetail: sent.errorBody,
        payload: { ...logCtx, reply_text: body },
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
      return "send_failed";
    }

    const ts = new Date().toISOString();
    const { error: insErr } = await admin.from("messages").insert({
      conversation_id: ctx.conversationId,
      direction: "outbound",
      message_type: "text",
      content: body,
      timestamp: ts,
      meta_message_id: sent.metaMessageId ?? null,
    });
    if (insErr) {
      await logError({
        admin,
        source: SOURCE,
        errorType: "send_succeeded_insert_failed",
        message: insErr.message,
        context: { ...logCtx, meta_message_id: sent.metaMessageId ?? null },
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
      });
    }
    await admin
      .from("conversations")
      .update({ last_interaction_at: ts })
      .eq("id", ctx.conversationId);
    await logError({
      admin,
      source: SOURCE,
      errorType: "button_action_replied",
      level: "info",
      message: `deterministic button reply sent (${resolved.actionName})`,
      context: { ...logCtx, meta_message_id: sent.metaMessageId ?? null },
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return "sent";
  } catch (err) {
    await logError({
      admin,
      source: SOURCE,
      errorType: "button_action_crashed",
      message: err instanceof Error ? err.message : String(err),
      context: logCtx,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
    });
    return "send_failed";
  }
}
