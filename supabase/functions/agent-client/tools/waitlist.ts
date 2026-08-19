import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import { activeProfessionals, utcToLocal, weekdayOf } from "./appointments.ts";

/**
 * # A fila de quem quer um horário que não tem
 *
 * O dia cheio é hoje uma porta fechada: o cliente ouve "não temos" e vai
 * procurar outro lugar. Enquanto isso alguém cancela às 15h e a cadeira fica
 * vazia — as duas coisas no mesmo dia, sem que uma saiba da outra. É a perda
 * mais silenciosa de uma barbearia, porque não aparece em lugar nenhum: nem
 * como cliente perdido, nem como horário ocioso.
 *
 * Entrar na fila é oferta da assistente, no momento da recusa, e não uma coisa
 * que alguém precise operar. Quem acabou de ouvir "não tem" é exatamente quem
 * aceita ser avisado, e trinta segundos depois já não é.
 *
 * ## Por que só entrar, e nada mais
 *
 * Sair da fila é o convite não respondido, e disso cuida o relógio. Consultar a
 * fila é assunto de quem atende, na tela. A ferramenta faz uma coisa, e é a que
 * só pode acontecer dentro da conversa. - 2026/08/10
 */

const JoinInputSchema = z.object({
  title: z.string().describe(
    "What they want, in their own words — 'corte', 'corte + barba'. It is what the staff will read when the slot frees.",
  ),
  date: z.string().optional().describe(
    "The day they want, YYYY-MM-DD in the business's own timezone. LEAVE IT OUT when they say any day works — that is a different request, not a wide range, and it is the one that fills a chair fastest.",
  ),
  period: z.enum(["morning", "afternoon"]).optional().describe(
    "Only when they said so. Leave it out when any time of day works.",
  ),
  professional: z.string().optional().describe(
    "By name, ONLY when they asked for someone in particular. Leaving it out means anybody, which is what most people accept and what gets them called first.",
  ),
});

const JoinOutputSchema = z.object({
  joined: z.boolean(),
  position: z.number().nullable().describe(
    "How many people are ahead of them for that day. NEVER promise a slot will appear — say you will let them know if one does, and nothing more.",
  ),
  refused: z.string().nullable(),
});

async function joinImplementation(
  input: z.infer<typeof JoinInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof JoinOutputSchema>> {
  const equipe = await activeProfessionals(
    supabaseClient,
    context.organization.id,
  );

  const pedido = input.professional?.trim().toLowerCase();

  const profissional = pedido
    ? equipe.find((pessoa) => pessoa.name.trim().toLowerCase() === pedido)
    : undefined;

  if (pedido && !profissional) {
    return {
      joined: false,
      position: null,
      refused: `Nobody here is called "${input.professional}".`,
    };
  }

  /**
   * Pedir duas vezes a mesma coisa não faz duas linhas.
   *
   * Quem insiste — e insistir é o normal de quem quer encaixe — acabaria com
   * três lugares na fila, e ainda passaria na frente de quem pediu uma vez só.
   * A ordem de chegada é a única que não precisa ser explicada a um cliente
   * irritado, e ela morre se o pedido repetido criar linha nova.
   */
  const { data: jaEstava } = await supabaseClient
    .from("waitlist")
    .select("id")
    .eq("organization_id", context.organization.id)
    .eq("contact_address", context.conversation.contact_address ?? "")
    .eq("status", "waiting")
    .is("desired_date", input.date ?? null)
    .limit(1);

  if (!jaEstava?.length) {
    const { error } = await supabaseClient.from("waitlist").insert({
      organization_id: context.organization.id,
      conversation_id: context.conversation.id,
      contact_address: context.conversation.contact_address,
      service: context.conversation.service,
      organization_address: context.conversation.organization_address,
      title: input.title,
      desired_date: input.date ?? null,
      desired_period: input.period ?? null,
      professional_id: profissional?.id ?? null,
    });

    if (error) {
      return {
        joined: false,
        position: null,
        refused: "The request could not be saved.",
      };
    }
  }

  const { count } = await supabaseClient
    .from("waitlist")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", context.organization.id)
    .eq("status", "waiting")
    .is("desired_date", input.date ?? null);

  return { joined: true, position: count ?? null, refused: null };
}

export const JoinWaitlistTool: ToolDefinition<
  typeof JoinInputSchema,
  typeof JoinOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "join_waitlist",
  // "Writing that you will keep an eye out puts nobody on any list" entrou em
  // 2026/08/10, na primeira medição da corrente inteira: perguntada se avisaria
  // caso vagasse, a assistente respondeu "ok, vou ficar de olho e te aviso
  // assim que surgir um horário livre" — e não chamou nada. Meia hora depois
  // uma cadeira vagou de verdade, e a cliente que tinha sido tranquilizada não
  // recebeu nada, porque ninguém sabia que ela existia.
  //
  // É a mesma falha que `transfer_to_human_agent` aprendeu em 2026/08/04, com
  // as mesmas palavras: para o modelo, escrever a frase e executar a ação
  // parecem a mesma coisa.
  description:
    "Put this customer on the waiting list for a time that is not available. CALLING THIS TOOL IS THE ONLY THING THAT PUTS ANYBODY ON ANY LIST — 'vou ficar de olho' or 'te aviso se vagar' puts nobody on it, and leaves them sure they are covered. If you say you will let them know, you MUST call it in the same turn. Offer it in the same message as the refusal ('não temos quarta; quer que eu te avise se vagar?') and call it when they accept. NEVER when there IS a free time — offer the time instead. NEVER promise a slot will appear or say how likely it is; only that they are on the list. ALWAYS WRITE IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(JoinInputSchema),
  outputSchema: z.toJSONSchema(JoinOutputSchema),
  implementation: joinImplementation,
};

/**
 * O convite, quando uma cadeira vaga.
 *
 * Chamado de dentro do cancelamento e da remarcação — os dois momentos em que
 * um horário deixa de estar ocupado. Um por vez, e o primeiro que pediu: chamar
 * todo mundo junto preenche mais rápido e transforma o encaixe numa corrida
 * onde a maioria perde, o que custa mais clientes do que a cadeira vazia.
 *
 * Falha em silêncio de propósito. Quem chama está cancelando um compromisso, e
 * o cancelamento é o que importa: derrubá-lo porque o convite não saiu seria
 * trocar um erro pequeno por um grande. - 2026/08/10
 */
export async function convidarDaFila(
  supabaseClient: SupabaseClient,
  organizationId: string,
  vaga: {
    startsAt: Date;
    professionalId: string | null;
    timeZone: string;
  },
): Promise<string | null> {
  const dia = utcToLocal(vaga.startsAt, vaga.timeZone).slice(0, 10);
  const hora = utcToLocal(vaga.startsAt, vaga.timeZone).slice(11);
  const periodo = Number(hora.slice(0, 2)) < 12 ? "morning" : "afternoon";

  const { data: fila } = await supabaseClient
    .from("waitlist")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "waiting")
    .order("created_at");

  const candidato = (fila ?? []).find((pedido) => {
    // "Qualquer dia" aceita este; um dia marcado só aceita o próprio.
    if (pedido.desired_date && pedido.desired_date !== dia) return false;

    if (pedido.desired_period && pedido.desired_period !== periodo) {
      return false;
    }

    // Quem pediu uma pessoa só quer a vaga dela. Quem não pediu aceita
    // qualquer uma, inclusive esta.
    if (
      pedido.professional_id && vaga.professionalId &&
      pedido.professional_id !== vaga.professionalId
    ) {
      return false;
    }

    return true;
  });

  if (!candidato) return null;

  /**
   * O dia da semana em português, e não o que `weekdayOf` devolve.
   *
   * Aquele fala para o MODELO, e por isso é em inglês — é a mesma escolha que
   * mantém todas as descrições de ferramenta em inglês. Aqui o leitor é o
   * cliente, e a primeira medição saiu "Vagou um horário wednesday 12/08",
   * inglês no meio de uma frase em português. - 2026/08/10
   */
  const DIAS_EM_PORTUGUES: Record<string, string> = {
    sunday: "domingo",
    monday: "segunda",
    tuesday: "terça",
    wednesday: "quarta",
    thursday: "quinta",
    friday: "sexta",
    saturday: "sábado",
  };

  const nomeDoDia =
    DIAS_EM_PORTUGUES[weekdayOf(vaga.startsAt, vaga.timeZone)] ??
      "";

  const quando = `${nomeDoDia} ${dia.slice(8)}/${dia.slice(5, 7)} às ${hora}`;

  const { error } = await supabaseClient.from("messages").insert({
    organization_id: organizationId,
    conversation_id: candidato.conversation_id,
    service: candidato.service,
    organization_address: candidato.organization_address,
    contact_address: candidato.contact_address,
    direction: "outgoing",
    content: {
      version: "1",
      type: "text",
      kind: "text",
      // Texto do sistema e não do modelo: o convite tem de sair no instante em
      // que a cadeira vaga, e chamar o modelo aqui seria pagar uma rodada e
      // arriscar um silêncio no único momento em que a mensagem tem prazo.
      text:
        `Oi! Vagou um horário ${quando} para ${candidato.title}. Quer esse horário? Responda aqui e eu confirmo — se não responder, ofereço para a próxima pessoa da fila.`,
    },
  });

  if (error) return null;

  await supabaseClient
    .from("waitlist")
    .update({
      status: "offered",
      offered_at: new Date().toISOString(),
      offered_for: vaga.startsAt.toISOString(),
    })
    .eq("id", candidato.id);

  return candidato.id as string;
}
