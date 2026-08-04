import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";

/**
 * Hands the conversation to a person.
 *
 * Without it the agent has no way to admit a limit: faced with something it
 * cannot resolve it either invents an answer or stalls, and the only exit is
 * for somebody to notice and pause it by hand. Noticing is the part that does
 * not happen.
 *
 * The state it writes is the one the product already has. `extra.paused` is
 * exactly "the agent stops answering here", the chat list already renders it,
 * and the same menu that pauses by hand also undoes this. A parallel flag
 * would have meant two ways to say one thing, and a `PAUSED_CONV_WINDOW` check
 * in `index.ts` that honours only one of them.
 *
 * `extra.handoff` sits alongside because `paused` alone cannot say *who*
 * paused, and that difference is the whole point: a conversation muted by hand
 * wants nothing, while one the agent gave up on is waiting for a person.
 * - 2026/08/01
 */

const TransferToHumanAgentInputSchema = z.object({
  reason: z.string().describe(
    "Why this conversation needs a person, addressed to the colleague who will pick it up — not to the customer. State what was asked and what you could not resolve. WRITE IT IN THE LANGUAGE OF THE CONVERSATION, never in English unless the conversation is in English: it is read by the business's own staff, in the chat list, not by a developer.",
  ),
});

const TransferToHumanAgentOutputSchema = z.object({
  transferred: z.boolean().describe(
    "True once the conversation has been handed over.",
  ),
  paused_until: z.string().describe(
    "ISO timestamp after which the agent resumes answering on its own, unless a person acts first.",
  ),
});

/** Mirrors `PAUSED_CONV_WINDOW` in `../index.ts`. */
const PAUSED_CONV_WINDOW = 12 * 60 * 60 * 1000; // 12 hours

export async function transferToHumanAgentImplementation(
  input: z.infer<typeof TransferToHumanAgentInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof TransferToHumanAgentOutputSchema>> {
  const at = new Date().toISOString();

  // A BEFORE UPDATE trigger on `conversations` runs `merge_update('extra')`,
  // so this adds two keys and leaves archived / pinned / default_agent_id
  // untouched. Writing the whole object back would be the bug, not the fix.
  await supabaseClient
    .from("conversations")
    .update({
      extra: {
        paused: at,
        handoff: {
          at,
          reason: input.reason,
          agent_id: context.agent.id,
        },
      },
    })
    .eq("id", context.conversation.id)
    .throwOnError();

  return {
    transferred: true,
    paused_until: new Date(+new Date(at) + PAUSED_CONV_WINDOW).toISOString(),
  };
}

export const TransferToHumanAgentTool: ToolDefinition<
  typeof TransferToHumanAgentInputSchema,
  typeof TransferToHumanAgentOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "transfer_to_human_agent",
  // "Calling this tool is the only thing that summons anyone" entrou depois de
  // uma medição: em "paguei e não recebi", o modelo respondeu "já chamei a
  // equipe" em 3 de 3 tentativas — e não chamou a ferramenta nenhuma vez.
  // Ninguém foi avisado, e o cliente ficou esperando alguém que não sabia que
  // existia. Num pedido de reembolso, 1 de 3.
  //
  // A descrição dizia o que a ferramenta faz e quando usá-la, mas não dizia que
  // *dizer* não faz nada. Para o modelo, escrever a frase e executar a ação
  // pareciam a mesma coisa. - 2026/08/04
  description:
    "Hand the conversation over to a human colleague and stop answering it yourself. Use this when you cannot resolve what is being asked: missing access, a decision that is not yours to make, a complaint, a payment that already happened, or an explicit request to speak to a person. CALLING THIS TOOL IS THE ONLY THING THAT ACTUALLY SUMMONS ANYONE — writing 'I will call someone' or 'I have called the team' in a message summons nobody, and leaves the customer waiting for a person who was never told. If you tell the customer that a colleague will take over, you MUST call this tool in the same turn. After calling it, tell the customer plainly that a colleague will take over, and do not promise a deadline. ALWAYS WRITE TO THE CUSTOMER IN THE LANGUAGE THEY ARE USING — this instruction being in English says nothing about the language of your reply. Prefer transferring over guessing: an invented answer costs more than a wait.",
  inputSchema: z.toJSONSchema(TransferToHumanAgentInputSchema),
  outputSchema: z.toJSONSchema(TransferToHumanAgentOutputSchema),
  implementation: transferToHumanAgentImplementation,
};
