import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

/**
 * Chamadas cruas à Graph API da Meta, e a validação de token que as
 * antecede — extraído de `whatsapp-management/manual_signup.ts` em
 * 2026/08/28 pra `loja/index.ts` (descobrir números a partir de um token de
 * sistema) poder reaproveitar exatamente a mesma lógica, em vez de duplicar
 * a checagem de token — o tipo de coisa que diverge quando existe em dois
 * lugares. Nada aqui é específico de conectar um número; é só "falar com a
 * Graph API" e "saber que tipo de token é este".
 */

export const API_VERSION = "v24.0";
const APP_ID = Deno.env.get("META_APP_ID");
const APP_SECRET = Deno.env.get("META_APP_SECRET");

/**
 * Nenhuma chamada aqui tinha limite de tempo — um `fetch` sem
 * `AbortSignal.timeout` espera pra sempre se a Meta não responder, e quem
 * pediu (o navegador de quem clicou em "Buscar") trava junto, sem erro
 * nenhum na tela. 20s é generoso pra uma chamada de leitura da Graph API,
 * e curto o bastante pra nunca parecer "quebrado" — achado ao vivo em
 * 2026/08/28, `descobrir` travando pra sempre sem essa timeout. - 2026/08/28
 */
const TIMEOUT_MS = 20_000;

export async function graph(
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).catch((err) => {
    throw new HTTPException(504, {
      message: `${message} (a Meta não respondeu a tempo)`,
      cause: err,
    });
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message,
      cause: body,
    });
  }

  return body;
}

/** Best-effort Graph read: a source that cannot answer contributes nothing. */
async function graphIds(path: string, token: string): Promise<string[]> {
  const body = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).then((response) => response.ok ? response.json() : null).catch(() => null);

  return ((body?.data ?? []) as { id?: string }[])
    .map((row) => row.id)
    .filter((id): id is string => !!id);
}

export async function inspectTokenRaw(token: string) {
  if (!APP_ID || !APP_SECRET) return null;

  const ids = APP_ID.split("|");
  const secrets = APP_SECRET.split("|");

  for (let index = 0; index < ids.length; index++) {
    const appToken = `${ids[index]}|${secrets[index]}`;

    const response = await fetch(
      `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${
        encodeURIComponent(token)
      }&access_token=${encodeURIComponent(appToken)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    ).catch(() => null);

    if (!response) continue;

    const body = await response.json().catch(() => ({}));

    if (response.ok && body?.data?.is_valid) {
      return body.data as {
        app_id?: string;
        expires_at?: number;
        granular_scopes?: { scope: string; target_ids?: string[] }[];
      };
    }
  }

  return null;
}

/**
 * What kind of token this is, asked of Meta rather than guessed.
 *
 * A user token from a browser session looks exactly like a system user token
 * and expires in about an hour. `debug_token` is the only thing that can
 * tell them apart. It answers with our own app's token, which means it only
 * works for tokens issued to our app — a token from someone else's app
 * fails here, and that failure is worth reporting: webhooks are delivered to
 * the app the token belongs to, so a number connected with it would send but
 * never receive.
 */
export async function inspectToken(token: string) {
  if (!APP_ID || !APP_SECRET) {
    throw new HTTPException(500, {
      message: "META_APP_ID or META_APP_SECRET environment variable not set",
    });
  }

  const data = await inspectTokenRaw(token);

  if (!data) return null;

  return {
    /** 0 means "never", which is what a system user token should say. */
    expires_at: Number(data.expires_at ?? 0),
  };
}

/**
 * Every WhatsApp Business Account a token can reach, without being told
 * which business it belongs to.
 *
 * Two sources, combined: what the token itself was scoped to (`debug_token`'s
 * granular scopes — empty for tokens issued before that feature, and for a
 * deploy-wide fallback token), and every business the token can see via
 * `me/businesses`, walked for both accounts it owns and accounts it manages
 * on a client's behalf (the partner arrangement, where the account belongs
 * to the customer). Bounded on purpose: a token with access to a hundred
 * accounts should not turn one screen into a hundred round trips.
 */
export async function candidateWabas(
  token: string,
  recorded?: string,
): Promise<string[]> {
  const ids = new Set<string>();

  if (recorded) ids.add(recorded);

  const inspected = await inspectTokenRaw(token);

  for (const scope of inspected?.granular_scopes ?? []) {
    for (const id of scope.target_ids ?? []) ids.add(id);
  }

  for (
    const business of (await graphIds("me/businesses?limit=10", token))
      .slice(0, 5)
  ) {
    for (
      const waba of [
        ...await graphIds(
          `${business}/owned_whatsapp_business_accounts?limit=50`,
          token,
        ),
        ...await graphIds(
          `${business}/client_whatsapp_business_accounts?limit=50`,
          token,
        ),
      ]
    ) {
      ids.add(waba);
    }
  }

  return [...ids].slice(0, 25);
}
