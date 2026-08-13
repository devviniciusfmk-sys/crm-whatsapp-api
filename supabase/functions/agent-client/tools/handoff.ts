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
  /**
   * As medições que escreveram cada frase da descrição abaixo, guardadas AQUI
   * e não lá dentro.
   *
   * Uma descrição de ferramenta é paga em toda chamada ao modelo, para sempre.
   * Medido em 2026/08/11: 4.615 tokens de descrição por chamada, 86% da
   * entrada — e boa parte era narrativa de medição, escrita para humano e
   * cobrada do modelo. Comentário custa zero e é lido por quem vai mexer, que
   * é quem precisa dela. A regra fica na descrição; a história fica aqui.
   *
   *   2026/08/09 — "cortaram minha orelha, tô no pronto socorro" saiu como
   *   `cannot_resolve` 3 vezes em 3: o modelo leu "não consigo resolver isso" e
   *   escolheu literalmente, e o caso mais grave do dia chegou na cor calma.
   *   Daí a ordem das perguntas, e daí a frase de que "não consigo resolver"
   *   descreve VOCÊ e não o que aconteceu com ELE.
   *
   *   2026/08/09 — pedido de estorno também caía em `cannot_resolve`, pelo
   *   mesmo motivo: o modelo classificava pela própria impotência. Daí dinheiro
   *   já pago ser reclamação, dito com todas as letras.
   */
  kind: z.enum(["complaint", "wants_person", "cannot_resolve"]).describe(
    "Ask these IN ORDER, stop at the first yes. (1) Did something go wrong FOR THEM — bad result, injury, failed service, upset or in distress — or is it about money already paid (overcharged, refund, chargeback, disputing a bill)? Then 'complaint', however urgent and however far the fix is from you. An emergency is a complaint; a refund request is a complaint; somebody hurt by the service is the clearest complaint there is, even when what they need next is a doctor. 'I cannot resolve this' describes YOU, not what happened to THEM, and never decides this field. (2) Did they simply ask for a human, nothing having gone wrong? Then 'wants_person'. (3) Otherwise 'cannot_resolve', and only this: something you lack the information to answer, with a customer who is not upset, owed nothing, and to whom nothing bad happened. Complaints show red and get picked up first — when hesitating, choose 'complaint'.",
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
    "Hand the conversation to a human colleague and stop answering it yourself: a complaint, money already paid, a decision that is not yours, or an explicit request for a person. CALLING THIS TOOL IS THE ONLY THING THAT SUMMONS ANYBODY — writing 'I will call someone' summons nobody and leaves them waiting for a person who was never told. If you say a colleague will take over, you MUST call it in the same turn. NEVER call it for something you can answer from what you were given — opening hours, closed days, the catalogue, prices, the calendar. Explaining that the shop is closed on a day is your job, not a colleague's. NEVER call it for anything ANOTHER TOOL answers: booking, cancelling, rescheduling, free times, the waiting list, a staff member asking their own schedule or their own earnings, a customer asking about the loyalty card. Those have tools. Handing one of them to a person looks careful and is not — it makes somebody wait for an answer that was one call away, and on a Saturday night nobody comes. If a question feels sensitive but a tool covers it, CALL THE TOOL: the tool decides who may hear the answer, and it refuses on its own when they may not. The reverse matters just as much: anything about the business NOT in what you were given — parking, wifi, payment methods, the address, promotions, stock — you do not know, and must never state either way; say you will check and call this tool. Calling it PAUSES the conversation, so everything they write next goes unanswered until a person shows up. Afterwards tell them plainly that a colleague will take over, without promising a deadline. ALWAYS WRITE IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(TransferToHumanAgentInputSchema),
  outputSchema: z.toJSONSchema(TransferToHumanAgentOutputSchema),
  implementation: transferToHumanAgentImplementation,
};
