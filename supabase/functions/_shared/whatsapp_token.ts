import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types/database_types.ts";

// Fallback for accounts onboarded before per-address tokens existed (and for
// local development). Kept out of the Vault on purpose: it is a deploy-time
// secret, not per-tenant data.
const DEFAULT_ACCESS_TOKEN = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN") ||
  "";

/**
 * Reads a WhatsApp address' Meta access token from Supabase Vault.
 *
 * The token used to live in `organizations_addresses.extra`, where every member
 * of the org could read it via RLS. It is now a Vault secret and
 * `public.get_whatsapp_access_token` is only executable by `service_role`, so
 * `client` must be a service-role client (`createUnsecureClient()`).
 */
export async function getWhatsAppAccessToken(
  client: SupabaseClient<Database>,
  organization_id: string,
  address: string,
): Promise<string> {
  const { data, error } = await client.rpc("get_whatsapp_access_token", {
    p_organization_id: organization_id,
    p_address: address,
  });

  if (error) {
    throw new Error(
      `Could not read the WhatsApp access token for ${organization_id}/${address}`,
      { cause: error },
    );
  }

  const token = data || DEFAULT_ACCESS_TOKEN;

  // Previously a missing token degraded to an empty Bearer header and failed
  // at Meta with an opaque 401. Fail here instead, where the address is known.
  if (!token) {
    throw new Error(
      `No WhatsApp access token for ${organization_id}/${address}`,
    );
  }

  return token;
}

/**
 * Writes (or rotates) a WhatsApp address' Meta access token in Supabase Vault.
 * Service-role client only, same as the getter.
 */
export async function setWhatsAppAccessToken(
  client: SupabaseClient<Database>,
  organization_id: string,
  address: string,
  token: string,
): Promise<void> {
  const { error } = await client.rpc("set_whatsapp_access_token", {
    p_organization_id: organization_id,
    p_address: address,
    p_token: token,
  });

  if (error) {
    throw new Error(
      `Could not store the WhatsApp access token for ${organization_id}/${address}`,
      { cause: error },
    );
  }
}
