import { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";
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

function buildPrompt(
  description: string,
  language: string,
  examples: string[],
): string {
  return `You write WhatsApp Business message templates that pass Meta's review.

The business describes what they want to send. Produce ONE template.

Rules, all mandatory:
- Write the body in this language: ${language}. Never in another language.
- UTILITY is for messages about something that already happened between the
  business and that specific person: an order, a booking, a delivery, a delay.
  MARKETING is for anything promotional, or for reopening a conversation.
  Choosing MARKETING when UTILITY fits costs the business more money, and
  choosing UTILITY for a promotion gets the template rejected.
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

export async function draftTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  description: string,
  language: string,
  examples: string[],
): Promise<TemplateDraft> {
  const { genai, model } = await getAI(client, organization_id);

  let prompt = buildPrompt(description, language, examples);

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
