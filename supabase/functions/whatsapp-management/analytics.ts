import { createUnsecureClient, type Database } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { getWhatsAppAccessToken } from "../_shared/whatsapp_token.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

/**
 * Billable conversations and what they cost, from Meta.
 *
 * The ask was a chart of utility versus marketing sends "with simulated
 * values". Simulation would have meant a hardcoded price table — and WhatsApp
 * prices differ per country and per category and Meta revises them, so the
 * table would be wrong somewhere on the day it shipped and silently wrong
 * forever after. Meta reports the real charges for the account, in the
 * account's own currency, so there is nothing to simulate.
 *
 * One caveat is Meta's own: cost comes back empty for accounts billed through
 * a Solution Partner's credit line. The count is still there, so the screen
 * shows volume and says the money is not available rather than showing zero.
 * - 2026/08/01
 */

const API_VERSION = "v24.0";

export type ConversationPoint = {
  start: number;
  end: number;
  conversation_category?: string;
  conversation?: number;
  cost?: number;
};

export type ConversationAnalytics = {
  points: ConversationPoint[];
  /** Absent when Meta does not report charges for this account. */
  currency?: string;
};

export async function fetchAnalytics(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  days: number,
): Promise<ConversationAnalytics> {
  // The WABA holds the analytics, not the phone number — so unlike the profile
  // and health calls, this one needs the account id.
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id")
    .eq("organization_id", organization_id)
    .eq("address", organization_address)
    .eq("service", "whatsapp")
    .single();

  if (error || !data?.waba_id) {
    throw new HTTPException(403, {
      message: "Could not fetch business credentials",
      cause: error,
    });
  }

  const access_token = await getWhatsAppAccessToken(
    createUnsecureClient(),
    organization_id,
    organization_address,
  );

  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 24 * 60 * 60;

  // The field is a nested query, not query parameters: the periods and the
  // dimensions live inside `fields`, which is why this reads unlike every
  // other Graph call in this codebase.
  // Dimensions are quoted, despite Meta's own example showing them bare:
  // unquoted, the API answers "the parameter dimensions must be an array".
  // Measured, not assumed — and worth writing down, because the documentation
  // is the thing that looks authoritative here and is wrong.
  //
  // An empty `phone_numbers` means every number on the account, which is right:
  // the analytics live on the WABA rather than on one number.
  const field =
    `conversation_analytics.start(${start}).end(${end}).granularity(DAILY)` +
    `.phone_numbers([]).dimensions(["CONVERSATION_CATEGORY"])`;

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${data.waba_id}` +
      `?fields=${encodeURIComponent(field)}`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );

  const body = await response.json();

  if (!response.ok) {
    log.error("Fetching conversation analytics failed", body);

    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Fetching conversation analytics failed",
      cause: body,
    });
  }

  const points: ConversationPoint[] =
    body?.conversation_analytics?.data?.[0]?.data_points ?? [];

  // Meta reports the currency only where it reports charges at all.
  const currency = points.some((point) => typeof point.cost === "number")
    ? body?.conversation_analytics?.data?.[0]?.currency ?? "USD"
    : undefined;

  return { points, currency };
}
