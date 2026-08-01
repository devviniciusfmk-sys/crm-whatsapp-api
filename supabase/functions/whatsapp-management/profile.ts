import { createUnsecureClient, type Database } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { getWhatsAppAccessToken } from "../_shared/whatsapp_token.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

/**
 * The business profile a customer sees when they open the conversation.
 *
 * It is the only part of this product visible from the other side, and until
 * now the only way to set it was Meta's own dashboard — which is the moment an
 * owner discovers this is not the whole system.
 *
 * `profile_picture_handle` is deliberately absent. Setting the photo needs
 * Meta's resumable upload against the *app* id, a separate two-step flow that
 * returns a handle; the text fields are one request and carry most of the
 * value. See crm-whatsapp-api#29. - 2026/08/01
 */

const API_VERSION = "v24.0";

/** The fields Meta returns; anything unset simply does not come back. */
const FIELDS = [
  "about",
  "address",
  "description",
  "email",
  "websites",
  "vertical",
] as const;

export type BusinessProfile = {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  /** Meta's business category, from a fixed list. */
  vertical?: string;
};

/**
 * Proves the caller may act on this number, and returns the token.
 *
 * The phone number id *is* the `organization_address` — the same convention
 * the dispatcher relies on when it posts messages. No extra lookup for it.
 */
async function getCredentials(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<string> {
  // The caller's own client, so this read is RLS-checked: someone outside the
  // organization finds no row and gets a 403 rather than a token.
  const { data, error } = await client
    .from("organizations_addresses")
    .select("address")
    .eq("organization_id", organization_id)
    .eq("address", organization_address)
    .eq("service", "whatsapp")
    .single();

  if (error || !data) {
    log.error("Could not fetch business credentials", error);

    throw new HTTPException(403, {
      message: "Could not fetch business credentials",
      cause: error,
    });
  }

  // The token is a Vault secret readable only by service_role. Membership and
  // role were already proven by the route guard and the RLS-checked read
  // above, so escalating just for this is safe — the same reasoning
  // `templates.ts` documents.
  return await getWhatsAppAccessToken(
    createUnsecureClient(),
    organization_id,
    organization_address,
  );
}

async function graph(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = await response.json();

  if (!response.ok) {
    log.error(`${what} failed`, body);

    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `${what} failed`,
      cause: body,
    });
  }

  return body as Record<string, unknown>;
}

export async function fetchProfile(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<BusinessProfile> {
  const access_token = await getCredentials(
    client,
    organization_id,
    organization_address,
  );

  const body = await graph(
    `https://graph.facebook.com/${API_VERSION}/${organization_address}` +
      `/whatsapp_business_profile?fields=${FIELDS.join(",")}`,
    { headers: { Authorization: `Bearer ${access_token}` } },
    "Fetching business profile",
  );

  // Meta wraps it in `data: [profile]` even though there is only ever one.
  const [profile] = (body.data as BusinessProfile[] | undefined) ?? [];

  return profile ?? {};
}

export async function updateProfile(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  profile: BusinessProfile,
): Promise<BusinessProfile> {
  const access_token = await getCredentials(
    client,
    organization_id,
    organization_address,
  );

  // Only what the caller sent. Meta treats an omitted field as "leave alone"
  // and an empty string as "clear", so passing undefined through would erase
  // whatever the owner set in Meta's dashboard before this screen existed.
  const payload: Record<string, unknown> = { messaging_product: "whatsapp" };

  for (const field of FIELDS) {
    if (profile[field] !== undefined) payload[field] = profile[field];
  }

  await graph(
    `https://graph.facebook.com/${API_VERSION}/${organization_address}` +
      `/whatsapp_business_profile`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    "Updating business profile",
  );

  // Meta answers `{ success: true }`, not the saved profile. Reading it back
  // is what makes the screen show what is actually stored — including any
  // normalisation Meta applied on the way in.
  return await fetchProfile(client, organization_id, organization_address);
}
