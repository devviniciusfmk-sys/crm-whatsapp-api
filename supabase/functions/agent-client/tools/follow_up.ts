import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import { localToUtc, utcToLocal } from "./appointments.ts";
import { DEFAULT_TIMEZONE } from "../protocols/context.ts";

/**
 * # "Agora não posso falar, me chama às seis"
 *
 * A frase mais comum que o sistema não sabia atender. Até aqui a assistente
 * respondia "claro, falamos depois" — e depois não acontecia, porque não havia
 * nada marcado em lugar nenhum. Do lado do cliente, uma promessa; do nosso,
 * silêncio.
 *
 * Não há máquina nova aqui: é a mesma mensagem de saída com data futura que o
 * lembrete e o relógio do chat já gravam. O despachante pega as linhas cuja
 * hora chegou, então ela fica parada até as seis e sai sozinha.
 *
 * ## A janela de 24 horas manda aqui também
 *
 * Texto livre só sai enquanto a janela da Meta estiver aberta, e ela conta do
 * ÚLTIMO recado do cliente. "Me chama daqui a três dias" cai fora, e agendar
 * assim mesmo seria agendar uma falha para depois de amanhã, sem ninguém por
 * perto para ver.
 *
 * Então a ferramenta confere a hora do ENVIO — não a de agora — e recusa com o
 * motivo quando não cabe. Quem decide o que dizer ao cliente é a assistente,
 * com a recusa na mão: "consigo te chamar até amanhã a esta hora; depois disso
 * preciso que você me mande um oi".
 *
 * ## Um por conversa
 *
 * O segundo pedido substitui o primeiro. Sem isso, o cliente que reagenda três
 * vezes recebe três mensagens no mesmo dia — e a que ele lembra é a última que
 * pediu, não as duas que esqueceu de cancelar. - 2026/08/13
 */

const JANELA_MS = 24 * 60 * 60 * 1000;

const FollowUpInputSchema = z.object({
  when: z.string().describe(
    "When to write back, 'YYYY-MM-DD HH:mm' in the business's own timezone. Resolve what they said — 'às seis', 'amanhã de manhã', 'depois do almoço' — into a real date and time. If it is ambiguous, ASK before calling this.",
  ),
  message: z.string().describe(
    "What to send them at that moment, in their language. They will read it cold, hours later, with the conversation long gone from their screen — so it MUST say that they asked you to write back, and about what. 'Oi Téo, você pediu para eu te chamar agora sobre o corte de sábado. Que horário fica bom?' is right. 'Oi, como posso ajudar?' is wrong: it reads like a stranger opening a conversation, and they will not remember asking for it.",
  ),
});

const FollowUpOutputSchema = z.object({
  scheduled_for: z.string().nullable().describe("Local time it will go out."),
  replaced_earlier: z.boolean().describe(
    "True when this replaced a previous callback for the same conversation. Worth mentioning so they know the old time is off.",
  ),
  refused: z.string().nullable(),
});

async function followUpImplementation(
  input: z.infer<typeof FollowUpInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof FollowUpOutputSchema>> {
  const timeZone =
    (context.organization.extra as { timezone?: string } | null)?.timezone ||
    DEFAULT_TIMEZONE;

  const quando = localToUtc(input.when, timeZone);

  if (!quando) {
    return {
      scheduled_for: null,
      replaced_earlier: false,
      refused:
        `The time could not be read. Use 'YYYY-MM-DD HH:mm'. (now it is ${
          utcToLocal(new Date(), timeZone)
        } there)`,
    };
  }

  if (quando.getTime() <= Date.now()) {
    return {
      scheduled_for: null,
      replaced_earlier: false,
      refused:
        "That moment is already in the past. Ask them when they want to be contacted, and do not claim you will write back until this tool accepts a time.",
    };
  }

  /**
   * A janela conta do último recado DELES, e a conferência é na hora do envio.
   *
   * `local` e `whatsapp-web` não têm janela: o primeiro é teste interno, o
   * segundo é ponte não oficial, e nos dois a Meta não está no caminho.
   */
  const service = context.conversation.service;
  const temJanela = service === "whatsapp" || service === "instagram";

  if (temJanela) {
    const { data } = await supabaseClient
      .from("messages")
      .select("timestamp")
      .eq("conversation_id", context.conversation.id)
      .eq("direction", "incoming")
      .order("timestamp", { ascending: false })
      .limit(1);

    const ultima = data?.[0]?.timestamp as string | undefined;

    const fecha = ultima ? new Date(ultima).getTime() + JANELA_MS : 0;

    if (quando.getTime() >= fecha) {
      return {
        scheduled_for: null,
        replaced_earlier: false,
        refused: `WhatsApp only lets us write freely for 24 hours after their last message, and that time is past it — the message would be refused when it went out, days later, with nobody watching. The last moment that still works is ${
          utcToLocal(new Date(fecha), timeZone)
        }. Offer to write back before then, or ask them to send you a message when they are free — do NOT promise to contact them at the time they asked for.`,
      };
    }
  }

  /**
   * O pedido anterior sai de cena.
   *
   * Apagado e não mantido: quem remarca o retorno duas vezes espera UM retorno,
   * e receber os dois faz o sistema parecer descontrolado. Só as que ainda não
   * saíram — mexer no que já foi entregue seria reescrever o histórico.
   */
  const { data: pendentes } = await supabaseClient
    .from("messages")
    .select("id")
    .eq("conversation_id", context.conversation.id)
    .eq("direction", "outgoing")
    .gt("timestamp", new Date().toISOString())
    .contains("content", { follow_up: true });

  const anteriores = pendentes ?? [];

  for (const linha of anteriores) {
    await supabaseClient.from("messages").delete().eq("id", linha.id);
  }

  const { error } = await supabaseClient.from("messages").insert({
    id: crypto.randomUUID(),
    organization_id: context.organization.id,
    conversation_id: context.conversation.id,
    service,
    organization_address: context.conversation.organization_address,
    contact_address: context.conversation.contact_address,
    direction: "outgoing",
    /**
     * `kind` continua "text", e a marca vai num campo à parte.
     *
     * Inventar `kind: "follow_up"` seria um valor que a TELA não conhece — e
     * quem desenha a bolha decide pelo `kind`, então a mensagem chegaria ao
     * cliente e apareceria em branco no painel. O lembrete já resolveu isso do
     * mesmo jeito, guardando `appointment_id` dentro do `content`.
     *
     * É por esta marca que o pedido anterior é encontrado e substituído, sem
     * tocar nos lembretes de compromisso, que são outra coisa.
     */
    content: {
      version: "1",
      type: "text",
      kind: "text",
      text: input.message,
      follow_up: true,
    },
    timestamp: quando.toISOString(),
  });

  if (error) {
    return {
      scheduled_for: null,
      replaced_earlier: false,
      refused: `Could not save it: ${error.message}`,
    };
  }

  return {
    scheduled_for: utcToLocal(quando, timeZone),
    replaced_earlier: anteriores.length > 0,
    refused: null,
  };
}

export const ScheduleFollowUpTool: ToolDefinition<
  typeof FollowUpInputSchema,
  typeof FollowUpOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "schedule_follow_up",
  description:
    "Write back to this person later, at a time THEY asked for — 'agora não posso falar, me chama às seis', 'me chama amanhã de manhã', 'estou dirigindo, fala comigo mais tarde'. CALLING THIS TOOL IS THE ONLY THING THAT MAKES YOU WRITE BACK: saying 'falo com você depois' schedules nothing and leaves them waiting for a message nobody will send. So if you tell them you will contact them at some point, you MUST call it in the same turn. Resolve what they said into a real date and time first, and ASK when it is ambiguous — 'de manhã' is not a time. It refuses when the moment is past, or when WhatsApp's 24-hour window will have closed by then; take the refusal at face value and tell them plainly what you can do instead, never promising a moment the tool would not accept. A second call replaces the first, so somebody who changes their mind gets one message and not two. ALWAYS REPLY IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(FollowUpInputSchema),
  outputSchema: z.toJSONSchema(FollowUpOutputSchema),
  implementation: followUpImplementation,
};
