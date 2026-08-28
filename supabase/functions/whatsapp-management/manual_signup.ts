import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import type { createClient } from "../_shared/supabase.ts";
import {
  getWhatsAppAccessToken,
  setWhatsAppAccessToken,
} from "../_shared/whatsapp_token.ts";
import {
  API_VERSION,
  candidateWabas,
  graph,
  inspectToken,
} from "../_shared/meta_graph.ts";

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

/** Same normalization the embedded flow does, so both paths store one shape. */
function normalizePhoneNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * The token this organization already holds for a WhatsApp Business Account.
 *
 * A WABA usually carries more than one number, and the credential belongs to
 * the account rather than to any one of them. Asking for it again to connect
 * the second number would be asking someone to go back to Business Manager and
 * mint a token they already gave us — the kind of friction that ends with the
 * same token pasted into a notes file so it is at hand next time.
 *
 * It is stored per address in the Vault, so any connected number of that WABA
 * can answer for it. - 2026/08/02
 */
async function storedTokenFor(
  client: ReturnType<typeof createClient>,
  organization_id: string,
  waba_id: string,
): Promise<string | null> {
  const { data } = await client
    .from("organizations_addresses")
    .select("address")
    .eq("organization_id", organization_id)
    .eq("service", "whatsapp")
    .eq("status", "connected")
    .eq("extra->>waba_id", waba_id)
    .limit(1);

  const address = data?.[0]?.address;

  if (!address) return null;

  try {
    return await getWhatsAppAccessToken(client, organization_id, address);
  } catch {
    // A connected row whose secret is missing is a broken connection, not a
    // reason to fail the lookup: the caller falls back to asking for a token.
    return null;
  }
}

export type WabaNumbersPayload = {
  organization_id: string;
  waba_id: string;
  /** Omitted when the organization already connected a number of this WABA. */
  access_token?: string;
};

/**
 * The numbers of a WhatsApp Business Account, and which are already connected.
 *
 * This exists so nobody has to type a phone number id. It is a long run of
 * digits that looks exactly like the WABA id sitting above it in the same
 * console, and swapping the two was the likeliest mistake on the manual
 * screen. Meta knows which numbers belong to the account; asking it is both
 * easier and correct by construction.
 */
export async function listWabaNumbers(
  client: ReturnType<typeof createClient>,
  payload: WabaNumbersPayload,
) {
  if (!payload.organization_id || !payload.waba_id) {
    throw new HTTPException(400, {
      message: "Missing 'organization_id' or 'waba_id' body param!",
    });
  }

  const token = payload.access_token?.trim() ||
    await storedTokenFor(client, payload.organization_id, payload.waba_id);

  if (!token) {
    throw new HTTPException(400, {
      message:
        "No stored token for this WhatsApp Business Account. Paste a system user token.",
    });
  }

  const inspected = await inspectToken(token);

  if (!inspected) {
    throw new HTTPException(400, {
      message:
        "This token was not issued to this platform's Meta app. Messages are delivered to the app that owns the token, so this number would send but never receive. Create the system user token from inside the app this platform uses.",
    });
  }

  const numbers = await graph(
    `${payload.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status&limit=100`,
    token,
    "Could not list the numbers of this WhatsApp Business Account. Check the WABA id and that the system user has access to it.",
  ) as {
    data?: {
      id: string;
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      code_verification_status?: string;
      /** "CLOUD_API" once the number is registered for the API. */
      platform_type?: string;
      status?: string;
    }[];
  };

  const { data: existing } = await client
    .from("organizations_addresses")
    .select("address, status")
    .eq("organization_id", payload.organization_id)
    .eq("service", "whatsapp");

  const connected = new Set(
    (existing ?? []).filter((row) => row.status === "connected").map((row) =>
      row.address
    ),
  );

  // A number this organization has already met, whether or not it is being
  // attended right now. `connected` alone would offer a number that is sitting
  // on the same screen a few rows up, marked as not attended — the same number
  // twice, in two different words.
  const known = new Set((existing ?? []).map((row) => row.address));

  return {
    token_expires_at: inspected.expires_at
      ? new Date(inspected.expires_at * 1000).toISOString()
      : null,
    numbers: (numbers.data ?? []).map((number) => ({
      ...number,
      connected: connected.has(number.id),
      known: known.has(number.id),
    })),
  };
}

/**
 * Which WhatsApp Business Account actually owns a connected number.
 *
 * `extra.waba_id` is written once, at connection time, and nothing has ever
 * checked it since. It can be wrong — a number moved between accounts, a
 * signup that recorded the account it was standing in rather than the one the
 * number ended up in — and when it is wrong the number keeps sending and
 * receiving perfectly, because messaging goes by phone number id. What breaks
 * is everything read by account: templates, conversation analytics, account
 * health. The first symptom is "my approved templates are not showing", which
 * reads like a bug in the template screen and is not.
 *
 * The token knows which accounts it can reach — `debug_token` lists them under
 * granular scopes — so the account that holds this number can be found rather
 * than guessed. - 2026/08/02
 *
 * `candidateWabas`/`graphIds`/`inspectTokenRaw` moved to
 * `_shared/meta_graph.ts` on 2026/08/28 — `loja/index.ts` needed the exact
 * same "every WABA this token can reach" logic to let an operator discover
 * numbers from a system token instead of typing each one by hand.
 */

export type DetectAccountPayload = {
  organization_id: string;
  organization_address: string;
  /** Write the detected account onto the address instead of only reporting. */
  apply?: boolean;
};

export async function detectAccount(
  client: ReturnType<typeof createClient>,
  payload: DetectAccountPayload,
) {
  if (!payload.organization_id || !payload.organization_address) {
    throw new HTTPException(400, {
      message:
        "Missing 'organization_id' or 'organization_address' body param!",
    });
  }

  const { data: address, error } = await client
    .from("organizations_addresses")
    .select()
    .eq("organization_id", payload.organization_id)
    .eq("address", payload.organization_address)
    .eq("service", "whatsapp")
    .single();

  if (error || !address) {
    throw new HTTPException(404, { message: "No such WhatsApp number here." });
  }

  const extra = (address.extra ?? {}) as { waba_id?: string };
  const recorded = extra.waba_id;

  const token = await getWhatsAppAccessToken(
    client,
    payload.organization_id,
    payload.organization_address,
  );

  const candidates = await candidateWabas(token, recorded);

  let detected: string | null = null;

  for (const waba_id of candidates) {
    // A candidate this token cannot read is not an answer; skip it rather than
    // failing the whole check on one inaccessible account.
    const numbers = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${waba_id}/phone_numbers?fields=id&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then((response) => response.ok ? response.json() : null).catch(() =>
      null
    );

    const found = (numbers?.data ?? []).some((row: { id: string }) =>
      row.id === payload.organization_address
    );

    if (found) {
      detected = waba_id;
      break;
    }
  }

  const mismatch = !!detected && detected !== recorded;

  if (payload.apply && mismatch) {
    log.info("Correcting the recorded WhatsApp Business Account", {
      organization_id: payload.organization_id,
      address: payload.organization_address,
      from: recorded,
      to: detected,
    });

    // merge_update on `extra` keeps everything else on the row untouched.
    await client
      .from("organizations_addresses")
      .update({ extra: { waba_id: detected } })
      .eq("organization_id", payload.organization_id)
      .eq("address", payload.organization_address)
      .throwOnError();

    await client.from("logs").insert({
      organization_id: payload.organization_id,
      organization_address: payload.organization_address,
      category: "signup",
      service: "whatsapp",
      level: "info",
      message:
        `WhatsApp Business Account corrected from ${recorded} to ${detected}`,
    });
  }

  return {
    recorded_waba_id: recorded ?? null,
    detected_waba_id: detected,
    /** True when the recorded account is not the one holding this number. */
    mismatch,
    /** True when no reachable account holds it — nothing to correct to. */
    undetermined: !detected,
    applied: !!payload.apply && mismatch,
    checked: candidates.length,
  };
}

export type ManualSignupPayload = {
  organization_id: string;
  phone_number_id: string;
  waba_id: string;
  /** Omitted when the organization already connected a number of this WABA. */
  access_token?: string;
  business_id?: string;
  callback_url?: string;
  verify_token?: string;
};

export type ConnectWhatsAppNumberPayload = {
  organization_id: string;
  phone_number_id: string;
  waba_id: string;
  business_id?: string;
  callback_url?: string;
  verify_token?: string;
  /**
   * Como esta conexão nasceu, gravado em `extra.flow_type`. "manual" é o
   * padrão porque o único chamador até 2026/08/26 era `performManualSignup`
   * — o dono do dado que essa coluna sempre teve. "loja" é o terceiro valor,
   * ao lado de "embedded" (`embedded_signup.ts`) e "manual": a mesma conexão
   * à Graph API, só que disparada pela entrega de um número comprado na loja
   * em vez de alguém colando um token na tela.
   */
  flow_type?: "manual" | "loja";
};

/**
 * O que acontece depois de já se ter um token em mãos, dado por quem for.
 *
 * Extraído de `performManualSignup` em 2026/08/26 para a entrega da loja de
 * números (`loja_delivery.ts`) poder reaproveitar exatamente estes passos —
 * mesmo `debug_token`, mesma checagem de que o número pertence à WABA, mesma
 * assinatura de webhooks — em vez de duplicá-los com um token que já estava
 * guardado no cofre desde que o número entrou no estoque, e não colado por
 * ninguém na tela. `performManualSignup` continua sendo o único lugar que
 * resolve QUAL token usar (colado ou já guardado); isto aqui é o que se faz
 * com ele depois de resolvido.
 */
export async function connectWhatsAppNumber(
  client: ReturnType<typeof createClient>,
  token: string,
  payload: ConnectWhatsAppNumberPayload,
) {
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
        flow_type: payload.flow_type ?? "manual",
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

/**
 * A conexão manual: cola-se um token, ou reaproveita-se o que a organização já
 * tinha guardado para esta WABA.
 *
 * A parte que sabe QUAL token usar termina aqui — `access_token?.trim() ||
 * storedTokenFor(...)` é a única decisão específica desta tela. Tudo que
 * acontece depois de ter um token em mãos é idêntico para qualquer origem, e
 * mora em `connectWhatsAppNumber` acima.
 */
export async function performManualSignup(
  client: ReturnType<typeof createClient>,
  payload: ManualSignupPayload,
) {
  const required: (keyof ManualSignupPayload)[] = [
    "organization_id",
    "phone_number_id",
    "waba_id",
  ];

  for (const field of required) {
    if (!payload[field]) {
      throw new HTTPException(400, {
        message: `Missing '${field}' body param!`,
      });
    }
  }

  const token = payload.access_token?.trim() ||
    await storedTokenFor(client, payload.organization_id, payload.waba_id);

  if (!token) {
    throw new HTTPException(400, {
      message:
        "No stored token for this WhatsApp Business Account. Paste a system user token.",
    });
  }

  return connectWhatsAppNumber(client, token, {
    organization_id: payload.organization_id,
    phone_number_id: payload.phone_number_id,
    waba_id: payload.waba_id,
    business_id: payload.business_id,
    callback_url: payload.callback_url,
    verify_token: payload.verify_token,
  });
}
