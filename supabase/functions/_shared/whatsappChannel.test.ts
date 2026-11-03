import { describe, expect, it } from "vitest";
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import {
  pickWhatsAppChannel,
  resolveAgentWhatsAppChannel,
  whatsAppChannelsFromEnv,
} from "./whatsappChannel.ts";

const ENV: Record<string, string> = {
  WHATSAPP_API_URL: "https://global.example/v22.0",
  WHATSAPP_ACCESS_TOKEN: "global-token",
  WHATSAPP_PHONE_NUMBER_ID: "111",
  WHATSAPP_API_URL_DM: "https://dm.example/v22.0",
  WHATSAPP_ACCESS_TOKEN_DM: "dm-token",
  WHATSAPP_PHONE_NUMBER_ID_DM: "222",
};

/** The channel a test env should produce for one env-name suffix. */
function expected(suffix: "" | "_DM") {
  return {
    apiUrl: ENV[`WHATSAPP_API_URL${suffix}`],
    accessToken: ENV[`WHATSAPP_ACCESS_TOKEN${suffix}`],
    phoneNumberId: ENV[`WHATSAPP_PHONE_NUMBER_ID${suffix}`],
  };
}

const GLOBAL = expected("");
const DM = expected("_DM");

function envOf(env: Record<string, string>) {
  return (key: string) => env[key];
}

describe("whatsAppChannelsFromEnv", () => {
  it("keys the global and _DM channels by their phone number id", () => {
    const channels = whatsAppChannelsFromEnv(envOf(ENV));
    expect(channels.fallback).toEqual(GLOBAL);
    expect(channels.byPhoneId.get("111")).toEqual(GLOBAL);
    expect(channels.byPhoneId.get("222")).toEqual(DM);
  });

  it("skips a channel that is only partly configured", () => {
    const { WHATSAPP_ACCESS_TOKEN_DM: _drop, ...partial } = ENV;
    const channels = whatsAppChannelsFromEnv(envOf(partial));
    expect(channels.byPhoneId.has("222")).toBe(false);
    expect(channels.fallback).toEqual(GLOBAL);
  });

  it("has no fallback when the global secrets are missing", () => {
    const channels = whatsAppChannelsFromEnv(envOf({}));
    expect(channels.fallback).toBeNull();
    expect(channels.byPhoneId.size).toBe(0);
  });
});

describe("pickWhatsAppChannel", () => {
  const channels = whatsAppChannelsFromEnv(envOf(ENV));

  it("uses the DM channel for an agent whose phone id is the DM number", () => {
    expect(pickWhatsAppChannel(channels, "222")).toEqual(DM);
  });

  it("falls back to the global channel for a phone id not configured in env", () => {
    expect(pickWhatsAppChannel(channels, "999")).toEqual(GLOBAL);
  });

  it("falls back to the global channel when the agent has no phone id", () => {
    expect(pickWhatsAppChannel(channels, null)).toEqual(GLOBAL);
  });
});

/** Minimal stub of the supabase-js chain used by resolveAgentWhatsAppChannel. */
function fakeAdmin(result: { data: unknown; error: { message: string } | null }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(result) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

/** A client that fails the test if it is touched at all. */
const unusedAdmin = {
  from: () => {
    throw new Error("agents should not be queried");
  },
} as unknown as SupabaseClient;

describe("resolveAgentWhatsAppChannel", () => {
  const channels = whatsAppChannelsFromEnv(envOf(ENV));

  it("sends a digital_marketing row from the DM number", async () => {
    const admin = fakeAdmin({ data: { whatsapp_phone_number_id: "222" }, error: null });
    expect(await resolveAgentWhatsAppChannel(admin, "agent-dm", channels)).toEqual(DM);
  });

  it("uses the global channel without a DB read when the row has no agent", async () => {
    expect(await resolveAgentWhatsAppChannel(unusedAdmin, null, channels)).toEqual(GLOBAL);
  });

  it("uses the global channel when the agent row is gone", async () => {
    const admin = fakeAdmin({ data: null, error: null });
    expect(await resolveAgentWhatsAppChannel(admin, "agent-x", channels)).toEqual(GLOBAL);
  });

  it("throws instead of guessing a number when the agents lookup fails", async () => {
    const admin = fakeAdmin({ data: null, error: { message: "boom" } });
    await expect(resolveAgentWhatsAppChannel(admin, "agent-dm", channels)).rejects.toThrow(/boom/);
  });
});
