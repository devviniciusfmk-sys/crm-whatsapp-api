import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import type { createClient } from "../_shared/supabase.ts";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";
import { setWhatsAppAccessToken } from "../_shared/whatsapp_token.ts";

/**
 * Connecting a number without the Facebook popup.
 *
 * Embedded Signup is the same three facts — a WABA, a phone number and a token
 * — collected by Meta's own dialog. Someone who will not log in to Facebook
 * inside our product can still produce those three by hand: the WABA lives in
 * their Business Manager, and a system user there issues a permanent token.
 * This takes them, checks them, and writes the same row.
 *
 * It is not a way around Meta — nothing is. The WABA must already exist and
 * the token must already have been issued. What it removes is the requirement
 * that the person holding the Facebook password be sitting at our screen.
 *
 * Every step below exists because the alternative is a row that looks
 * connected and silently is not: a token for the wrong number, a mistyped WABA
 * id, a user token that dies in an hour, an app that was never subscribed to
 * the account's webhooks. Each of those fails days later as "the robot stopped
 * answering", with nothing on screen to explain it. - 2026/08/02
 */

const API_VERSION = "v24.0";
const APP_ID = Deno.env.get("META_APP_ID");
const APP_SECRET = Deno.env.get("META_APP_SECRET");

/** Same normalization the embedded flow does, so both paths store one shape. */
function normalizePhoneNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function graph(
  path: string,
  token: string,
  message: string,
  init?: RequestInit,
) {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    },
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message,
      cause: body,
    });
  }

  return body;
}

/**
 * What kind of token this is, asked of Meta rather than guessed.
 *
 * A user token from a browser session looks exactly like a system user token
 * and expires in about an hour. Pasting one here would connect the number,
 * work for the rest of the meeting, and break overnight. `debug_token` is the
 * only thing that can tell them apart, so it runs before anything is written.
 *
 * It answers with our own app's token, which means it only works for tokens
 * issued to our app. A token from someone else's app makes this fail, and that
 * failure is worth reporting: webhooks are delivered to the app the token
 * belongs to, so messages would never reach us.
 */
async function inspectToken(token: string) {
  if (!APP_ID || !APP_SECRET) {
    throw new HTTPException(500, {
      message: "META_APP_ID or META_APP_SECRET environment variable not set",
    });
  }

  // Multi-app deploys keep several ids in one variable, pipe-separated. Any of
  // them recognising the token is enough.
  const ids = APP_ID.split("|");
  const secrets = APP_SECRET.split("|");

  for (let index = 0; index < ids.length; index++) {
    const appToken = `${ids[index]}|${secrets[index]}`;

    const response = await fetch(
      `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${
        encodeURIComponent(token)
      }&access_token=${encodeURIComponent(appToken)}`,
    );

    const body = await response.json().catch(() => ({}));

    if (response.ok && body?.data?.is_valid) {
      return {
        app_id: String(body.data.app_id ?? ids[index]),
        /** 0 means "never", which is what a system user token should say. */
        expires_at: Number(body.data.expires_at ?? 0),
        type: String(body.data.type ?? ""),
        scopes: (body.data.scopes ?? []) as string[],
      };
    }
  }

  return null;
}

export type ManualSignupPayload = {
  organization_id: string;
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  business_id?: string;
  callback_url?: string;
  verify_token?: string;
};

export async function performManualSignup(
  client: ReturnType<typeof createClient>,
  payload: ManualSignupPayload,
) {
  const required: (keyof ManualSignupPayload)[] = [
    "organization_id",
    "phone_number_id",
    "waba_id",
    "access_token",
  ];

  for (const field of required) {
    if (!payload[field]) {
      throw new HTTPException(400, {
        message: `Missing '${field}' body param!`,
      });
    }
  }

  const token = payload.access_token.trim();

  const ctx = {
    organization_id: payload.organization_id,
    phone_number_id: payload.phone_number_id,
    waba_id: payload.waba_id,
  };

  log.info("Manual connect: inspecting the token", ctx);
  const inspected = await inspectToken(token);

  if (!inspected) {
    throw new HTTPException(400, {
      message:
        "This token was not issued to this platform's Meta app. Messages are delivered to the app that owns the token, so this number would send but never receive. Create the system user token from inside the app this platform uses.",
    });
  }

  // Zero means no expiry. Anything else is a date this connection stops
  // working on, and saying it now beats discovering it then.
  const expires_at = inspected.expires_at
    ? new Date(inspected.expires_at * 1000).toISOString()
    : null;

  if (inspected.expires_at && inspected.expires_at * 1000 < Date.now()) {
    throw new HTTPException(400, {
      message: "This token has already expired.",
    });
  }

  log.info("Manual connect: reading the phone number", ctx);
  const phone_number = await graph(
    `${payload.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type`,
    token,
    "Could not read this phone number with this token. Check the phone number id and that the system user has access to it.",
  ) as {
    display_phone_number: string;
    verified_name: string;
    quality_rating?: string;
    code_verification_status?: string;
    platform_type?: string;
  };

  // A phone number id and a WABA id are both long strings of digits, and
  // nothing about them says which is which. Pasted the wrong way round, or
  // taken from a different account, everything above still succeeds and the
  // row lands pointing at a WABA that does not hold this number — which shows
  // up much later as templates that are not there.
  log.info("Manual connect: checking the number belongs to the WABA", ctx);
  const owned = await graph(
    `${payload.waba_id}/phone_numbers?fields=id&limit=100`,
    token,
    "Could not list the numbers of this WhatsApp Business Account. Check the WABA id.",
  ) as { data?: { id: string }[] };

  if (!(owned.data ?? []).some((row) => row.id === payload.phone_number_id)) {
    throw new HTTPException(400, {
      message:
        "This number does not belong to that WhatsApp Business Account. Check that the two ids were not swapped.",
    });
  }

  // Without this the number sends and never receives. Deliberately fatal: a
  // CRM that cannot receive is not connected, and a warning on a success
  // screen is a warning nobody reads.
  log.info("Manual connect: subscribing to webhooks", ctx);
  await graph(
    `${payload.waba_id}/subscribed_apps`,
    token,
    "Could not subscribe to this account's webhooks. Without it, incoming messages never arrive.",
    { method: "POST" },
  );

  if (payload.callback_url && payload.verify_token) {
    log.info("Manual connect: overriding the callback URL", ctx);
    await graph(
      `${payload.waba_id}/subscribed_apps`,
      token,
      "Could not override the callback URL.",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          override_callback_uri: payload.callback_url,
          verify_token: payload.verify_token,
        }),
      },
    );
  }

  log.info("Manual connect: storing the token in the vault", ctx);
  await setWhatsAppAccessToken(
    client,
    payload.organization_id,
    payload.phone_number_id,
    token,
  );

  log.info("Manual connect: persisting the address", ctx);
  const { data, error } = await client
    .from("organizations_addresses")
    .upsert({
      service: "whatsapp",
      address: payload.phone_number_id,
      organization_id: payload.organization_id,
      status: "connected",
      extra: {
        waba_id: payload.waba_id,
        business_id: payload.business_id,
        flow_type: "manual",
        phone_number: normalizePhoneNumber(phone_number.display_phone_number),
        verified_name: phone_number.verified_name,
        token_expires_at: expires_at,
        callback_url: payload.callback_url || null,
        verify_token: payload.verify_token || null,
      },
    })
    .select()
    .single();

  if (error) {
    throw new HTTPException(500, {
      message: "Could not persist phone number data",
      cause: error,
    });
  }

  await client.from("logs").insert({
    organization_id: payload.organization_id,
    organization_address: data.address,
    category: "signup",
    service: "whatsapp",
    level: "info",
    message: "WhatsApp account connected manually",
  });

  log.info("Manual connect: account connected", ctx);

  // `/register` is not called here. A number already living in a WABA is
  // usually registered; one that is not needs a 2FA PIN this flow never asks
  // for. Its status is returned instead, so the screen can say so rather than
  // this guessing. - 2026/08/02
  return {
    ...data,
    code_verification_status: phone_number.code_verification_status,
    token_expires_at: expires_at,
  };
}
