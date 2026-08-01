import {
  createUnsecureClient,
  type Database,
  type TemplateData,
} from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { getWhatsAppAccessToken } from "../_shared/whatsapp_token.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

const API_VERSION = "v24.0";

async function getBusinessCredentials(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<{ waba_id: string; access_token: string }> {
  // `client` is the caller's user-/api-key-scoped client: this lookup is still
  // RLS-checked, so a caller outside the org gets no row and a 403 below.
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id")
    .eq("organization_id", organization_id)
    .eq("address", organization_address)
    .single();

  if (error || !data) {
    log.error("Could not fetch business credentials", error);
    throw new HTTPException(403, {
      message: "Could not fetch business credentials",
      cause: error,
    });
  }

  // The token is a Vault secret readable only by service_role. Membership and
  // role were already proven by the route's requireRoles guard and the
  // RLS-checked lookup above, so escalating just for the read is safe.
  const access_token = await getWhatsAppAccessToken(
    createUnsecureClient(),
    organization_id,
    organization_address,
  );

  return { waba_id: data.waba_id, access_token };
}

export async function listTemplates(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<TemplateData[]> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  // Two defects fixed together, both invisible until now.
  //
  // This returned Meta's envelope — `{ data: [...], paging: {...} }` — while
  // its signature promised `TemplateData[]`. The route re-wrapped it and the UI
  // read `data.data`, so the screen worked and the lie went unnoticed. It
  // surfaced when something called this function directly: the draft generator
  // does `.filter()` on the result, which throws every time, inside a catch
  // that returns an empty list. Learning from approved templates never ran.
  //
  // And it read one page. Meta returns 25 by default with a cursor for the
  // rest; an account with more simply lost them, with nothing to notice.
  // - 2026/08/01
  const templates: TemplateData[] = [];

  let url =
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates?limit=100`;

  // Bounded so a paging surprise upstream stalls one request instead of
  // looping forever. A hundred pages is far past any real account.
  for (let page = 0; page < 100 && url; page++) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!response.ok) {
      throw new HTTPException(response.status as ContentfulStatusCode, {
        message: "Could not fetch templates",
        cause: await response.json().catch(() => ({})),
      });
    }

    const body = await response.json() as {
      data?: TemplateData[];
      paging?: { next?: string };
    };

    templates.push(...(body.data ?? []));

    url = body.paging?.next ?? "";
  }

  return templates;
}

export async function fetchTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<TemplateData> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function createTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  id: string;
  status: string;
  category: string;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const { name, category, language, components } = template;

  const filteredTemplate = {
    name,
    category,
    allow_category_change: true,
    language,
    components,
  };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not create template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function editTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const { category, components } = template;
  const filteredTemplate = { category, components };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not update template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

export async function deleteTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_id,
    organization_address,
  );

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates?name=${template.name}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    },
  );

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not delete template",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}
