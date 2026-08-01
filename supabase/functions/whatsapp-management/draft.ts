import { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";
import { listTemplates } from "./templates.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";

/**
 * Turns a sentence — typed or spoken — into a WhatsApp template draft.
 *
 * A gallery of ready-made templates came first and was rejected for being
 * exactly what it was: six fixed situations, none of them anybody's. Describing
 * the message you want is both simpler for the person and more general for the
 * product.
 *
 * The model is told the rules, but is not trusted with them. Everything it
 * returns is checked mechanically and asked for again once if it breaks
 * something — because the failures here are boring and checkable (a variable
 * opening the text, a missing example) and Meta rejects for exactly those.
 * What no check can promise is approval; nothing can. - 2026/08/01
 */

/** Uses the organization's media-preprocessing credentials. */
type AIConfig = { model?: string; api_key?: string };

export type TemplateDraft = {
  name: string;
  category: "MARKETING" | "UTILITY";
  body: string;
  examples: string[];
  footer?: string;
};

const DEFAULT_MODEL = "gemini-flash-latest";

/**
 * Meta's code to the language name the UI sends, so an approved template can
 * be matched against the language being written.
 *
 * The names have to be the ones `utils/whatsappLanguages.ts` produces on the
 * other side; they are the same list, and both are written in Spanish because
 * that is the key language the UI translates from.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  pt_BR: "Portugués (Brasil)",
  pt_PT: "Portugués (Portugal)",
  es: "Español",
  es_AR: "Español (Argentina)",
  es_ES: "Español (España)",
  es_MX: "Español (México)",
  en: "Inglés",
  en_US: "Inglés (EE. UU.)",
  en_GB: "Inglés (Reino Unido)",
  fr: "Francés",
  sw: "Suajili",
};

const whatsappLanguageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

async function getAI(
  client: SupabaseClient<Database>,
  organization_id: string,
): Promise<{ genai: GoogleGenAI; model: string }> {
  // The caller's own client: RLS decides whether they may read this row.
  const { data, error } = await client
    .from("organizations")
    .select("extra")
    .eq("id", organization_id)
    .single();

  if (error || !data) {
    throw new HTTPException(403, {
      message: "Could not read organization",
      cause: error,
    });
  }

  const config = ((data.extra ?? {}) as { media_preprocessing?: AIConfig })
    .media_preprocessing ?? {};

  const apiKey = config.api_key || Deno.env.get("GOOGLE_API_KEY");

  if (!apiKey) {
    // Named plainly, because the fix is a screen away and a generic failure
    // would send someone hunting through the wrong settings.
    throw new HTTPException(400, {
      message:
        "No AI key configured. Set one in Integrations → Media preprocessing.",
    });
  }

  return {
    genai: new GoogleGenAI({ apiKey }),
    model: config.model || DEFAULT_MODEL,
  };
}

/** What Meta rejects mechanically, checked before the user ever sees it. */
function problemsWith(draft: TemplateDraft): string[] {
  const problems: string[] = [];
  const body = (draft.body ?? "").trim();

  if (!body) problems.push("The body is empty.");

  if (!/^[a-z0-9_]{1,512}$/.test(draft.name ?? "")) {
    problems.push("The name must be lowercase letters, digits and underscores.");
  }

  if (!["MARKETING", "UTILITY"].includes(draft.category)) {
    problems.push("The category must be MARKETING or UTILITY.");
  }

  if (/^\s*\{\{\d+\}\}/.test(body)) {
    problems.push("The body must not start with a variable.");
  }

  if (/\{\{\d+\}\}\s*$/.test(body)) {
    problems.push("The body must not end with a variable.");
  }

  // Meta requires 1..n with no gaps, and one example per variable.
  const used = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const unique = [...new Set(used)].sort((a, b) => a - b);

  if (unique.some((n, index) => n !== index + 1)) {
    problems.push("Variables must be numbered {{1}}, {{2}}, … with no gaps.");
  }

  if ((draft.examples ?? []).length !== unique.length) {
    problems.push(
      `Provide exactly ${unique.length} example values, one per variable.`,
    );
  }

  return problems;
}

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    category: { type: "string", enum: ["MARKETING", "UTILITY"] },
    body: { type: "string" },
    examples: { type: "array", items: { type: "string" } },
  },
  required: ["name", "category", "body", "examples"],
};

/**
 * The rules come from Meta's own documentation rather than from a summary of
 * it, because the expensive mistake here is a judgement call and the wording
 * decides it:
 *
 *   developers.facebook.com/documentation/business-messaging/whatsapp/
 *     templates/template-categorization
 *   developers.facebook.com/docs/whatsapp/updates-to-pricing/
 *     new-template-guidelines
 *
 * The mixed-content rule is the one worth reading twice. A utility template
 * with a promotional line in it is silently recategorised as marketing, and
 * marketing costs more and needs consent — so the business ends up paying the
 * higher price for a message it thought was an order update. That failure is
 * invisible: the template is approved, it sends, and the bill is different.
 * - 2026/08/01
 */
function buildPrompt(
  description: string,
  language: string,
  examples: string[],
): string {
  return `You write WhatsApp Business message templates that pass Meta's review.

The business describes what they want to send. Produce ONE template.

Rules, all mandatory:
- Write the body in this language: ${language}. Never in another language.
- Category, in Meta's own terms. UTILITY requires BOTH of these to hold:
  (a) non-promotional — no promotional or persuasive intent anywhere in it;
  (b) specific to or requested by the user, OR essential/critical to them.
  MARKETING is everything else: awareness, offers, sales, win-backs.
  Meta's own examples —
    UTILITY:   "Thank you! Your order {{1}} is confirmed. We will let you know
                once your package is on its way."
    MARKETING: "As a thank you for your last order, please enjoy {{1}}% off
                your next order. Use code {{2}} at checkout."
- Never mix the two. Meta recategorises a utility template to marketing the
  moment it carries an offer, a discount, an upsell or a call to buy — "an
  order update with a promo" is their example. The business then pays the
  marketing price without ever choosing it. So if the description asks for an
  order update, write ONLY the order update: no "and enjoy 10% off next time",
  no "come visit us again", no invitation to purchase.
- Use {{1}}, {{2}}, … for the parts that change per customer. Number them from
  1 with no gaps, in the order they appear.
- The body must NOT begin or end with a variable. Put a word before and after.
- Provide exactly one example value per variable, in order, realistic for the
  language above.
- Keep it short: one or two sentences. No emoji unless the description asks.
- Spell correctly, with every accent the language requires, however the
  description was written. People type fast and without accents, and speech
  transcription drops them too — but the customer reads the result, and
  "inauguracao" in a shop's message looks like a mistake the shop made.
- Never request passwords, card numbers, documents or any sensitive data.
- The name must be lowercase letters, digits and underscores, describing the
  situation — for example pedido_pronto or lembrete_agendamento.

House style, for tone only — do not copy them:
${examples.map((example) => `- ${example}`).join("\n")}

What the business wants to send:
${description}`;
}

/**
 * Bodies of this organization's own approved templates, newest first.
 *
 * The gallery of approved templates already exists and is called Meta: it
 * holds every template and says which passed review. Storing a second copy
 * would add a table, a sync and a way to go stale, for information we can ask
 * for.
 *
 * Deliberately this organization's own, never anybody else's. Template bodies
 * carry a shop's name, its offers and its voice — commercial information, and
 * personal data once a customer's details are in the examples. Teaching one
 * customer's generator with another customer's messages would be a leak
 * dressed up as a feature. Learning from your own is free of that, and it is
 * where most of the value is anyway: it learns how *you* write.
 *
 * Same language only. An approved English template teaches nothing useful to a
 * Portuguese one except the wrong words. - 2026/08/01
 */
async function approvedExamples(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string | undefined,
  language: string,
): Promise<string[]> {
  if (!organization_address) return [];

  try {
    const templates = await listTemplates(
      client,
      organization_id,
      organization_address,
    );

    return templates
      .filter((template) =>
        template.status === "APPROVED" &&
        whatsappLanguageName(template.language) === language
      )
      .map((template) =>
        template.components.find((component) => component.type === "BODY")
      )
      .map((body) => (body && "text" in body ? body.text : ""))
      .filter(Boolean)
      // Enough to set a voice; more would crowd out the instructions and cost
      // tokens on every generation.
      .slice(0, 5);
  } catch (error) {
    // Never fatal. Losing the examples costs tone, not correctness, and a
    // Meta outage should not stop somebody writing a template.
    log.error("Could not read approved templates for examples", error);

    return [];
  }
}

export async function draftTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  description: string,
  language: string,
  examples: string[],
  organization_address?: string,
): Promise<TemplateDraft> {
  const { genai, model } = await getAI(client, organization_id);

  // What this business already got approved outranks the built-in samples: it
  // is proof of what passes review *and* of how they talk. The samples stay as
  // the fallback for an account with none yet.
  const approved = await approvedExamples(
    client,
    organization_id,
    organization_address,
    language,
  );

  let prompt = buildPrompt(
    description,
    language,
    approved.length ? approved : examples,
  );

  // One retry, and the retry is told exactly what was wrong. A second failure
  // is reported rather than papered over: a draft that breaks the rules would
  // be rejected by Meta anyway, and silently returning it would move the
  // confusion to a place that is much harder to explain.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await genai.models.generateContent({
      model,
      contents: [{ text: prompt }],
      config: { responseMimeType: "application/json", responseSchema: SCHEMA },
    });

    let draft: TemplateDraft;

    try {
      draft = JSON.parse(response.text ?? "") as TemplateDraft;
    } catch {
      log.error("Draft was not valid JSON", response.text);
      prompt += "\n\nYour previous answer was not valid JSON. Answer again.";
      continue;
    }

    const problems = problemsWith(draft);

    if (!problems.length) return draft;

    log.info("Draft rejected by validation", problems);

    prompt += `\n\nYour previous answer broke these rules:\n${
      problems.map((problem) => `- ${problem}`).join("\n")
    }\nAnswer again, fixing them.`;
  }

  throw new HTTPException(422, {
    message:
      "Could not build a template that follows Meta's rules. Try describing it differently.",
  });
}

/** Speech to text, so the description can be spoken instead of typed. */
export async function transcribe(
  client: SupabaseClient<Database>,
  organization_id: string,
  audio: { data: string; mime_type: string },
): Promise<string> {
  const { genai, model } = await getAI(client, organization_id);

  const response = await genai.models.generateContent({
    model,
    contents: [
      {
        text:
          "Transcribe this audio literally, in its own language. Answer with the transcription only.",
      },
      { inlineData: { mimeType: audio.mime_type, data: audio.data } },
    ],
  });

  return (response.text ?? "").trim();
}
