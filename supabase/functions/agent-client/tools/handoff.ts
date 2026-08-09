import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";

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
  /**
   * Conjunto fechado, e escolhido pelo modelo em vez de adivinhado do texto.
   *
   * A tela precisa distinguir uma reclamação de uma dúvida qualquer: quem volta
   * do almoço com oito conversas esperando não pode ter de ler as oito para
   * achar "cortaram minha orelha, tô no pronto socorro". Ler a categoria do
   * `reason` por palavra-chave seria a terceira expressão regular do dia a
   * decidir algo importante — duas já falharam hoje por uma vírgula e por uma
   * palavra no meio. O modelo já decidiu transferir; dizer de que tipo é sai de
   * graça e não depende de casar texto. - 2026/08/08
   */
  // A primeira redação desta descrição mandou "cortaram minha orelha, tô no
  // pronto socorro" para `cannot_resolve`: o modelo leu "não consigo resolver
  // isso" e escolheu literalmente, e o caso mais grave do dia saiu com a cor
  // calma. A ordem da pergunta é o conserto — decidir PRIMEIRO se algo deu
  // errado com a pessoa, e só depois pensar em quem resolve. - 2026/08/08
  kind: z.enum(["complaint", "wants_person", "cannot_resolve"]).describe(
    "What kind of handoff this is. Ask the questions IN THIS ORDER and stop at the first yes. (1) Did something go wrong FOR THIS PERSON — a bad result, an injury or any physical harm, a service that failed, or are they simply upset or in distress? ANYTHING ABOUT MONEY ALREADY PAID also counts: being charged more than agreed, asking for a refund or a chargeback, wanting their money back, disputing a bill. Then it is 'complaint', no matter how urgent it is or how far outside your reach the fix is. An emergency IS a complaint; a refund request IS a complaint. SOMEONE HURT BY THE SERVICE IS THE CLEAREST COMPLAINT THERE IS — a cut, a burn, a chemical reaction, an injury, a trip to hospital — and it stays 'complaint' even though what they need next is a doctor and not you: measured on 2026/08/09, 'cortaram minha orelha, tô no pronto socorro' was filed as 'cannot_resolve' three times out of three, which is the worst case of the day arriving in the calm colour. 'I cannot resolve this' describes YOU, not what happened to THEM, and it never decides this field. (2) Did they just ask to speak to a human, with nothing having gone wrong? Then 'wants_person'. (3) Otherwise 'cannot_resolve' — and ONLY this: a question you lack the information to answer, or a decision that is not yours to make, with a customer who is not upset, owed nothing, and to whom nothing bad happened. Staff see complaints marked in red and pick them up first; when hesitating, choose 'complaint', because a missed one costs far more than an extra one.",
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

/**
 * Pede só o que a transferência lê, e não o `RequestContext` inteiro.
 *
 * O `index.ts` também transfere — quando o assistente promete que alguém
 * retorna e não chama ninguém — e ali não existe um `RequestContext` montado.
 * Exigir um obrigaria a inventar `organization` e `messages` só para satisfazer
 * o tipo, ou a mentir com um `as unknown as`. Os dois escondem o dia em que
 * esta função passar a ler um campo novo. Assim ela declara o que precisa, e
 * `RequestContext` continua servindo por conter isso. - 2026/08/08
 */
type HandoffContext = {
  conversation: { id: string };
  agent: { id: string };
};

export async function transferToHumanAgentImplementation(
  input: z.infer<typeof TransferToHumanAgentInputSchema>,
  _config: void,
  context: HandoffContext,
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
          // O `index.ts` também transfere, sem passar por aqui, e naqueles dois
          // casos não há cliente reclamando — é o assistente que falhou.
          kind: input.kind ?? "cannot_resolve",
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
  // "NEVER call this for something you can answer" entrou em 2026/08/08, da
  // primeira conversa de WhatsApp de verdade. O cliente perguntou "na segunda
  // não tem?", a assistente transferiu — motivo registrado: "preciso que um
  // atendente explique a indisponibilidade" — e em seguida explicou ela mesma,
  // corretamente. Transferir pausa a conversa: a pergunta seguinte do cliente,
  // vinte segundos depois, caiu no vazio.
  //
  // A descrição dizia quando usar e terminava com "prefira transferir a
  // adivinhar". Faltava dizer que horário, catálogo e preço não são adivinhação
  // — são o que ela tem na mão.
  description:
    "Hand the conversation over to a human colleague and stop answering it yourself. Use this when you cannot resolve what is being asked: missing access, a decision that is not yours to make, a complaint, a payment that already happened, or an explicit request to speak to a person. NEVER call this for something you can already answer from what you were given — opening hours, closed days, the service catalogue, prices, or what the calendar shows. Explaining that the shop is closed on a day, or that a service is not offered, is your job, not a colleague's: answer it and keep going. The reverse is just as important: anything about the business that is NOT in what you were given — parking, wifi, payment methods, the address, promotions, who works which day, whether a product is in stock — you simply do not know, and you must NEVER state it as fact in either direction. Measured on 2026/08/09: asked 'do you have parking?', the assistant answered 'we have no parking at the salon' — invented, and the kind of invention a customer acts on. When you do not know, say you will check and call this tool. Calling this tool PAUSES the conversation, so everything the customer writes next goes unanswered until a person shows up — transferring what you could have answered leaves them waiting for nothing. CALLING THIS TOOL IS THE ONLY THING THAT ACTUALLY SUMMONS ANYONE — writing 'I will call someone' or 'I have called the team' in a message summons nobody, and leaves the customer waiting for a person who was never told. If you tell the customer that a colleague will take over, you MUST call this tool in the same turn. After calling it, tell the customer plainly that a colleague will take over, and do not promise a deadline. ALWAYS WRITE TO THE CUSTOMER IN THE LANGUAGE THEY ARE USING — this instruction being in English says nothing about the language of your reply. Prefer transferring over guessing: an invented answer costs more than a wait.",
  inputSchema: z.toJSONSchema(TransferToHumanAgentInputSchema),
  outputSchema: z.toJSONSchema(TransferToHumanAgentOutputSchema),
  implementation: transferToHumanAgentImplementation,
};
