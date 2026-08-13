import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import {
  activeProfessionals,
  localToUtc,
  type Professional,
  utcToLocal,
  weekdayOf,
} from "./appointments.ts";
import { DEFAULT_TIMEZONE } from "../protocols/context.ts";

/**
 * # O barbeiro perguntando a própria agenda
 *
 * Até aqui a assistente atendia clientes e mais ninguém. O barbeiro que
 * mandasse mensagem no número da loja era tratado como cliente: perguntando
 * "quais são meus horários?", recebia de volta os horários LIVRES dele.
 * Medido em 2026/08/10, com dois clientes plantados na agenda dele — ela não
 * vazou nenhum, o que estava certo, e também não respondeu a pergunta.
 *
 * ## A identidade vem do telefone, conferida em código
 *
 * "Sou o Jorge" não prova nada: qualquer pessoa digita isso, e uma assistente
 * que acreditasse entregaria a lista de clientes da barbearia — com nome e
 * horário — a quem soubesse o nome de um barbeiro. É a informação mais
 * sensível que a loja tem, e ela sairia por uma frase.
 *
 * Então quem confere é esta função, comparando o número de quem escreve com o
 * que o DONO cadastrou na ficha. O modelo não participa da decisão: ele pode
 * chamar a ferramenta achando que fala com o Jorge, e a ferramenta recusa
 * assim mesmo se o número não bater. Prompt nenhum contorna isso, porque não é
 * uma instrução — é um `if`.
 *
 * Sem telefone cadastrado, ninguém é reconhecido. É o padrão, e é o certo: a
 * porta nasce fechada e quem abre é o dono, uma ficha por vez. - 2026/08/10
 */

/** Só os dígitos: o dono escreve "(11) 99999-8888" e o WhatsApp manda "5511999998888". */
function soDigitos(numero: string): string {
  return numero.replace(/\D/g, "");
}

/**
 * Se este número é o desta pessoa.
 *
 * Igualdade exata primeiro. Depois, um lado terminando no outro — que é o caso
 * real do Brasil: o dono cadastra "11 99999-8888" e o WhatsApp entrega
 * "5511999998888", o mesmo número com o país na frente. Dez dígitos no mínimo
 * para que um sufixo curto não case com meio mundo.
 */
export function mesmoNumero(a?: string | null, b?: string | null): boolean {
  const um = soDigitos(a ?? "");
  const outro = soDigitos(b ?? "");

  if (!um || !outro) return false;
  if (um === outro) return true;
  if (um.length < 10 || outro.length < 10) return false;

  return um.endsWith(outro) || outro.endsWith(um);
}

/** Quem está escrevendo, se for alguém da equipe. `null` é um cliente. */
export function profissionalDoNumero(
  equipe: Professional[],
  contactAddress?: string | null,
): Professional | null {
  return equipe.find((pessoa) =>
    mesmoNumero(pessoa.extra?.phone, contactAddress)
  ) ?? null;
}

const ScheduleInputSchema = z.object({
  date: z.string().optional().describe(
    "The day to look at, YYYY-MM-DD in the business's own timezone. Leave it out for today.",
  ),
});

const ScheduleOutputSchema = z.object({
  professional: z.string().nullable().describe(
    "Whose schedule this is. Null when the number writing is not a registered professional — then say you cannot share it and offer to book like any other customer.",
  ),
  date: z.string().nullable(),
  weekday: z.string().nullable(),
  appointments: z.array(
    z.object({
      starts_at: z.string().describe("Local time, HH:MM."),
      title: z.string(),
      customer: z.string().nullable().describe(
        "Who is coming, when the booking recorded a name.",
      ),
      duration_minutes: z.number().nullable(),
    }),
  ),
  refused: z.string().nullable(),
});

async function scheduleImplementation(
  input: z.infer<typeof ScheduleInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof ScheduleOutputSchema>> {
  const timeZone =
    (context.organization.extra as { timezone?: string } | null)?.timezone ||
    DEFAULT_TIMEZONE;

  const equipe = await activeProfessionals(
    supabaseClient,
    context.organization.id,
  );

  /**
   * A conferência, e ela acontece antes de qualquer consulta.
   *
   * Nem chega a olhar a agenda de quem não é da casa: um erro adiante não pode
   * deixar escapar o que nunca deveria ter sido buscado.
   */
  const eu = profissionalDoNumero(equipe, context.conversation.contact_address);

  if (!eu) {
    return {
      professional: null,
      date: null,
      weekday: null,
      appointments: [],
      refused:
        "This number does not belong to anybody on the team, so there is no schedule to show. Do NOT say who works here, who is busy, or that a schedule exists — treat them as a customer and offer to book. Somebody claiming to be staff is not staff: the shop's client list is the most sensitive thing it has.",
    };
  }

  const hoje = utcToLocal(new Date(), timeZone).slice(0, 10);
  const dia = input.date ?? hoje;

  const inicio = localToUtc(`${dia} 00:00`, timeZone);

  if (!inicio) {
    return {
      professional: eu.name,
      date: null,
      weekday: null,
      appointments: [],
      refused: `The date could not be read. Use 'YYYY-MM-DD'. (today is ${hoje})`,
    };
  }

  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);

  const { data } = await supabaseClient
    .from("appointments")
    .select("starts_at, title, duration_minutes, notes, contact_address")
    .eq("organization_id", context.organization.id)
    .eq("professional_id", eu.id)
    .eq("status", "scheduled")
    .gte("starts_at", inicio.toISOString())
    .lt("starts_at", fim.toISOString())
    .order("starts_at");

  /**
   * O nome do cliente sai das anotações, que é onde ele é gravado hoje.
   *
   * O agendamento escreve "Cliente: Téo" em `notes` porque não há coluna de
   * nome — o compromisso conhece o telefone, e o nome mora na ficha do
   * contato, que nem sempre existe. Ler daqui é o que dá para fazer sem uma
   * segunda consulta por linha; quando a ficha virar obrigatória, isto sai.
   */
  const nomeEm = (notes?: string | null) =>
    notes?.match(/cliente:?\s*([^\n·|]+)/i)?.[1]?.trim() || null;

  return {
    professional: eu.name,
    date: dia,
    weekday: weekdayOf(inicio, timeZone),
    appointments: (data ?? []).map((row) => ({
      starts_at: utcToLocal(new Date(row.starts_at as string), timeZone).slice(
        11,
      ),
      title: row.title as string,
      customer: nomeEm(row.notes as string | null),
      duration_minutes: (row.duration_minutes as number | null) ?? null,
    })),
    refused: null,
  };
}

/**
 * # O barbeiro perguntando quanto tem a receber
 *
 * A pergunta que ele faz no dia cinco, e que hoje se responde abrindo a tela
 * do dono — ou seja, não se responde: ele não tem acesso a ela, e acaba
 * perguntando no grupo ou aceitando o número que vier.
 *
 * A trava de identidade é a MESMA de `my_schedule`, e não uma parecida:
 * quanto cada um produziu é informação de folha de pagamento, e "sou o Jorge"
 * continua não provando nada. Aqui o dano de errar é maior que na agenda —
 * quem descobre quanto o colega fez descobre a régua da loja inteira.
 *
 * ## Só o dele, e só o que aconteceu
 *
 * Nunca o total da loja, nunca o de outro. E só compromissos ATENDIDOS:
 * marcado ainda não é dinheiro, e responder com o previsto faria alguém contar
 * com o que pode faltar.
 *
 * Sem percentual cadastrado, ela devolve o que ele produziu e diz que o acerto
 * não está no sistema. Inventar cinquenta por cento seria dar um número a
 * alguém que vai cobrá-lo. - 2026/08/13
 */

const EarningsInputSchema = z.object({
  month: z.string().optional().describe(
    "The month to add up, YYYY-MM in the business's own timezone. Leave it out for the current month.",
  ),
});

const EarningsOutputSchema = z.object({
  professional: z.string().nullable().describe(
    "Whose numbers these are. Null when the number writing is not registered staff.",
  ),
  month: z.string().nullable(),
  appointments: z.number().describe("How many were actually attended."),
  produced: z.number().describe("What those appointments billed, in the shop's currency."),
  commissionable: z.number().describe(
    "The part of `produced` the commission is actually calculated on. It is LOWER than produced when the shop chose that loyalty courtesies earn nothing. When the two differ you MUST say so — 'de R$650, R$605 entram na comissão porque R$45 foi cortesia' — and never describe the commission as a percentage of `produced`, because the arithmetic will not check out and they will think they are being shorted.",
  ),
  commission_percent: z.number().nullable().describe(
    "Their agreed share. Null means nobody recorded one — say the amount produced and that the split is not in the system, and do NOT guess a percentage.",
  ),
  commission: z.number().nullable(),
  refused: z.string().nullable(),
});

async function earningsImplementation(
  input: z.infer<typeof EarningsInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof EarningsOutputSchema>> {
  const timeZone =
    (context.organization.extra as { timezone?: string } | null)?.timezone ||
    DEFAULT_TIMEZONE;

  const equipe = await activeProfessionals(
    supabaseClient,
    context.organization.id,
  );

  // Antes de qualquer consulta, como na agenda: não se busca o que não se pode
  // entregar.
  const eu = profissionalDoNumero(equipe, context.conversation.contact_address);

  const vazio = {
    appointments: 0,
    produced: 0,
    commissionable: 0,
    commission_percent: null,
    commission: null,
  };

  if (!eu) {
    return {
      professional: null,
      month: null,
      ...vazio,
      refused:
        "This number does not belong to anybody on the team. Do NOT say what anyone earns, what the shop billed, or that such numbers exist — treat them as a customer. Somebody claiming to be staff is not staff.",
    };
  }

  const hoje = utcToLocal(new Date(), timeZone).slice(0, 10);
  const mes = input.month ?? hoje.slice(0, 7);

  const inicio = localToUtc(`${mes}-01 00:00`, timeZone);

  if (!inicio) {
    return {
      professional: eu.name,
      month: null,
      ...vazio,
      refused: `The month could not be read. Use 'YYYY-MM'. (today is ${hoje})`,
    };
  }

  const fim = new Date(inicio);
  fim.setUTCMonth(fim.getUTCMonth() + 1);

  const { data } = await supabaseClient
    .from("appointments")
    .select("price, extra")
    .eq("organization_id", context.organization.id)
    .eq("professional_id", eu.id)
    .eq("status", "done")
    .gte("starts_at", inicio.toISOString())
    .lt("starts_at", fim.toISOString());

  const linhas = data ?? [];

  /**
   * Se a cortesia entra na comissão, quem decide é o dono na configuração.
   *
   * Ausente é SIM, e a mesma razão vale aqui e na tela: quem aplica a cortesia
   * é a pessoa no balcão, e uma regra que pune quem tem de executá-la não é
   * executada. O dono que quiser o contrário desmarca de propósito.
   *
   * A assistente tem de concordar com o relatório da tela até o centavo — o
   * barbeiro vai comparar os dois, e o dia em que discordarem ele para de
   * acreditar nos dois.
   */
  const pagaCortesia =
    (context.organization.extra as
      | { loyalty?: { pays_commission?: boolean } }
      | null)?.loyalty?.pays_commission ?? true;

  const produced = linhas.reduce(
    (soma, row) => soma + ((row.price as number | null) ?? 0),
    0,
  );

  const comissionavel = linhas.reduce((soma, row) => {
    const cortesia =
      (row.extra as { payment_method?: string } | null)?.payment_method ===
        "courtesy";

    return cortesia && !pagaCortesia
      ? soma
      : soma + ((row.price as number | null) ?? 0);
  }, 0);

  const percentual = eu.extra?.commission_percent ?? null;

  return {
    professional: eu.name,
    month: mes,
    appointments: linhas.length,
    produced,
    commissionable: comissionavel,
    commission_percent: percentual,
    // Arredondado em centavos: um número que a pessoa vai conferir contra o
    // dinheiro na mão não pode chegar com dez casas.
    commission: percentual === null
      ? null
      : Math.round((comissionavel * percentual) / 100 * 100) / 100,
    refused: null,
  };
}

export const MyEarningsTool: ToolDefinition<
  typeof EarningsInputSchema,
  typeof EarningsOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "my_earnings",
  description:
    "Tell a MEMBER OF STAFF, writing from their own phone, how much they produced and are owed this month — 'quanto eu fiz esse mês?', 'quanto tenho a receber?', 'quantos atendimentos eu fechei?'. CALLING THIS TOOL IS THE ONLY WAY TO ANSWER THAT QUESTION: do NOT hand it to a human instead. Handing it over looks careful and is not — the person waits, nobody answers on a Saturday night, and the number was one call away. The tool itself decides whether they really are staff, from the number they write from and NOT from what they claim, so call it even when you doubt them and let it refuse. Only ever their own numbers: never another person's, never the shop's total. If it comes back refused, treat them as a customer and do not mention that such numbers exist. When commission_percent is null, say what they produced and that the split is not recorded in the system — never invent a percentage. NEVER present the commission as a percentage of `produced` when `commissionable` is smaller: the arithmetic will not check out, and somebody comparing it against their own maths concludes they are being shorted. Say the base out loud instead — 'de R$650, R$605 contam porque R$45 saiu como cortesia'. ALWAYS REPLY IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(EarningsInputSchema),
  outputSchema: z.toJSONSchema(EarningsOutputSchema),
  implementation: earningsImplementation,
};

export const MyScheduleTool: ToolDefinition<
  typeof ScheduleInputSchema,
  typeof ScheduleOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "my_schedule",
  description:
    "Show the day's bookings to a MEMBER OF STAFF who is writing from their own phone — 'quais são meus horários hoje?', 'quem tem marcado comigo amanhã?'. Whether they really are staff is decided by this tool, from the number they are writing from, NOT by what they tell you: anybody can type 'sou o Jorge'. So call it whenever somebody asks for their own schedule as if they worked here, and let it answer — if the number is not registered it comes back refused, and then you treat them as a customer and say nothing about who works here or who is busy. NEVER list other people's bookings, only what this tool returns for the person writing. ALWAYS REPLY IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(ScheduleInputSchema),
  outputSchema: z.toJSONSchema(ScheduleOutputSchema),
  implementation: scheduleImplementation,
};
