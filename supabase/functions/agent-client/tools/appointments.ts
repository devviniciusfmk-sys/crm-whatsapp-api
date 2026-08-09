import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import { DEFAULT_TIMEZONE, isOpenAt } from "../protocols/context.ts";
import type {
  BusinessHours,
  OrganizationExtra,
} from "../../_shared/types/extra_types.ts";

/**
 * Marcar, consultar e cancelar compromissos pela conversa.
 *
 * O agente já sabia dizer que horas são; não sabia guardar nada. Sem estas
 * ferramentas, "pode ser quinta às 15h?" terminava numa promessa que ninguém
 * anotou — e o lembrete, que nasce do compromisso, nunca existia.
 *
 * Três decisões que valem mais que o código:
 *
 * **Só para quem está falando.** O contato vem da conversa, nunca do texto que
 * o modelo escreveu. Um parâmetro de telefone aqui seria um jeito de pedir
 * educadamente para o modelo marcar no número errado — ou para um cliente
 * marcar no lugar de outro.
 *
 * **A hora é local, e a conversão é nossa.** O modelo fala "quinta às 15h" e é
 * isso que ele manda. Se ele tivesse de calcular UTC, erraria três horas de vez
 * em quando, confiante, e só o cliente que perdesse o horário descobriria.
 *
 * **As recusas são verificações, não instruções.** Fora do horário, no
 * passado, em cima de outro compromisso: tudo conferido aqui. Regra escrita no
 * prompt é sugestão; regra no código é regra. - 2026/08/02
 */

/** Deslocamento do fuso naquele instante, em milissegundos. */
function offsetAt(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - date.getTime();
}

/**
 * "2026-08-05 15:00" no fuso da empresa vira o instante certo em UTC.
 *
 * Duas passadas de propósito: a primeira estima o deslocamento, a segunda o
 * confere no instante já corrigido. É o que acerta o horário de verão, onde a
 * conta de uma passada erra em uma hora nos dias da virada.
 */
export function localToUtc(local: string, timeZone: string): Date | null {
  const normalized = local.trim().replace(" ", "T");

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(normalized)) return null;

  const naive = Date.parse(`${normalized}Z`);

  if (Number.isNaN(naive)) return null;

  let utc = naive - offsetAt(new Date(naive), timeZone);
  utc = naive - offsetAt(new Date(utc), timeZone);

  return new Date(utc);
}

/** O mesmo instante escrito no fuso da empresa, para devolver ao modelo. */
export function utcToLocal(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  const hour = parts.hour === "24" ? "00" : parts.hour;

  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

/**
 * O dia da semana daquele instante, em inglês minúsculo.
 *
 * Devolvido junto com a data porque o modelo erra o nome do dia mesmo quando
 * acerta a data: numa simulação de vinte clientes ele marcou certo em
 * 2026-08-05 e chamou de "quinta-feira" ao confirmar, sendo quarta. O cliente
 * lê o nome, não a data — e aparece no dia errado. Contar dias é aritmética, e
 * a mesma razão que tirou a comparação de horário do modelo tira esta.
 * - 2026/08/02
 */
export function weekdayOf(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" })
    .format(date)
    .toLowerCase();
}

/** Índice do dia na semana como `BusinessHours` a guarda: domingo primeiro. */
const WEEKDAY_ORDER = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function wallClockDayIndex(date: Date, timeZone: string): number {
  return WEEKDAY_ORDER.indexOf(weekdayOf(date, timeZone));
}

/**
 * O horário de atendimento, quando de fato existe.
 *
 * A semana começa como sete `null` — a forma que a tela grava enquanto
 * ninguém ligou nenhum dia. Isso é "não configurado", e não "fechado a semana
 * inteira": uma empresa que fecha todos os dias não existe, e tratar assim
 * recusaria todo agendamento de toda organização que nunca abriu essa tela.
 * Só vale como regra quando ao menos um dia tem horário. - 2026/08/02
 */
function businessHoursOf(context: RequestContext) {
  const extra = (context.organization.extra ?? {}) as OrganizationExtra;
  const hours = extra.business_hours;

  return hours?.some((day) => !!day) ? hours : null;
}

function timezoneOf(context: RequestContext): string {
  const extra = (context.organization.extra ?? {}) as OrganizationExtra;

  return extra.timezone || DEFAULT_TIMEZONE;
}

// ---------------------------------------------------------------------------
// Duração e folga
// ---------------------------------------------------------------------------

type AppointmentsConfig = NonNullable<OrganizationExtra["appointments"]>;

function appointmentsConfigOf(context: RequestContext): AppointmentsConfig {
  const extra = (context.organization.extra ?? {}) as OrganizationExtra;

  return extra.appointments ?? {};
}

/** Quando ninguém configurou nada, meia hora é o palpite menos ruim. */
export const ASSUMED_MINUTES = 30;

function fallbackMinutes(config: AppointmentsConfig): number {
  return config.default_minutes ?? ASSUMED_MINUTES;
}

/**
 * O mesmo serviço escrito de outro jeito.
 *
 * O modelo repete o nome do catálogo com a caixa da frase — "Coloração" vira
 * "coloração" no meio de "quero agendar uma coloração" — e o cliente escreve
 * sem acento. Comparar byte a byte recusaria o serviço que a organização
 * oferece por causa de um til.
 */
export function sameService(a: string, b: string): boolean {
  const fold = (name: string) =>
    name.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

  return fold(a) === fold(b);
}

/**
 * Quantos minutos este compromisso ocupa.
 *
 * Com catálogo, a duração sai dele e só dele: o `duration_minutes` que o
 * modelo mandar é ignorado, porque a organização já disse quanto leva cada
 * serviço e um número inventado no meio da conversa não tem por que ganhar
 * dela. `null` é o serviço que não está no catálogo — recusa, com a lista, em
 * vez de marcar pelo palpite errado.
 *
 * Sem catálogo continua valendo o que o modelo disser, e o padrão da
 * organização quando ele não disser nada. É o caso de quem atende sempre o
 * mesmo tempo e não tem o que cadastrar. - 2026/08/03
 */
export function minutesFor(
  input: { service?: string; title?: string; duration_minutes?: number },
  config: AppointmentsConfig,
): number | null {
  const catalog = config.services ?? [];

  if (!catalog.length) return input.duration_minutes ?? fallbackMinutes(config);

  const found = serviceIn(catalog, input);

  return found ? found.minutes : null;
}

/**
 * O serviço do catálogo que corresponde ao pedido.
 *
 * O `title` também entra na busca porque ele costuma ser o nome do serviço nas
 * palavras do cliente; exigir os dois campos preenchidos seria recusar o
 * acerto.
 */
function serviceIn(
  catalog: NonNullable<AppointmentsConfig["services"]>,
  input: { service?: string; title?: string },
) {
  const asked = input.service?.trim() || input.title?.trim() || "";

  return catalog.find((service) => sameService(service.name, asked));
}

/**
 * Quanto custa, pelo catálogo.
 *
 * `null` quando não há preço cadastrado — que não é zero. Zero é o atendimento
 * de cortesia, e a diferença aparece em qualquer relatório. - 2026/08/03
 */
export function priceFor(
  input: { service?: string; title?: string },
  config: AppointmentsConfig,
): number | null {
  const found = serviceIn(config.services ?? [], input);

  return found?.price ?? null;
}

/**
 * O compromisso já marcado que colide com este, ou `null`.
 *
 * A folga entra dos dois lados do cálculo, e não só depois do que já estava
 * marcado: quem chega antes também precisa terminar cedo o bastante. Somá-la
 * apenas a um dos lados deixaria passar o compromisso novo que termina em cima
 * do começo do seguinte.
 */
export function findOverlap(
  booked: { starts_at: string; duration_minutes: number | null }[],
  startsAt: Date,
  minutes: number,
  config: AppointmentsConfig,
): Date | null {
  const buffer = (config.buffer_minutes ?? 0) * 60 * 1000;
  const endsAt = new Date(startsAt.getTime() + minutes * 60 * 1000 + buffer);

  for (const row of booked) {
    const otherStart = new Date(row.starts_at);
    const otherEnd = new Date(
      otherStart.getTime() +
        (row.duration_minutes ?? fallbackMinutes(config)) * 60 * 1000 + buffer,
    );

    if (startsAt < otherEnd && otherStart < endsAt) return otherStart;
  }

  return null;
}

/**
 * O compromisso inteiro cabe no horário de atendimento — não só o começo.
 *
 * Só o início era conferido, o que bastava enquanto tudo durava meia hora e
 * deixou de bastar no dia em que passou a durar duas: fechando às 18h, um
 * serviço marcado para 17h50 era aceito e terminava às 19h50, com o cliente na
 * cadeira e a loja fechada.
 *
 * A folga fica de fora desta conta de propósito: arrumar depois de fechar é
 * trabalho de quem fica, não motivo para recusar o último horário do dia.
 * - 2026/08/03
 */
export function fitsOpeningHours(
  hours: BusinessHours,
  timeZone: string,
  startsAt: Date,
  minutes: number,
): boolean {
  if (!isOpenAt(hours, timeZone, startsAt)) return false;

  // O último instante dentro, e não o instante do fim: um corte que termina às
  // 18:00 em ponto acabou em tempo, e às 18:00 a loja já está fechada.
  const lastMoment = new Date(startsAt.getTime() + minutes * 60 * 1000 - 1);

  return isOpenAt(hours, timeZone, lastMoment);
}

// ---------------------------------------------------------------------------
// Consultar o dia
// ---------------------------------------------------------------------------

const ListInputSchema = z.object({
  date: z.string().describe(
    "The first day to look at, as YYYY-MM-DD in the business's own timezone. Use the current date you were given to resolve words like 'tomorrow'.",
  ),
  until: z.string().optional().describe(
    "Last day to look at, YYYY-MM-DD, inclusive. Use it whenever the customer asks about more than one day — 'this week', 'any day', 'the next few days' — so you get the answer in ONE call instead of one call per day.",
  ),
});

const DaySchema = z.object({
  date: z.string(),
  weekday: z.string().describe(
    "Which day of the week that date falls on. Use THIS when you name the day to the customer — do not work it out yourself.",
  ),
  open: z.boolean().describe(
    "False when the business does not open at all on that day. Do not offer times on a closed day.",
  ),
  opens_at: z.string().nullable().describe("Opening time, HH:MM, or null."),
  closes_at: z.string().nullable().describe("Closing time, HH:MM, or null."),
  taken: z.array(
    z.object({
      starts_at: z.string().describe("Local time, HH:MM."),
      duration_minutes: z.number().nullable(),
      title: z.string(),
    }),
  ).describe(
    "Slots already booked that day, for every customer. Offer times that do not collide with these.",
  ),
});

const ListOutputSchema = z.object({
  default_duration_minutes: z.number().describe(
    "How long an appointment takes when nothing else says otherwise. Use it to work out whether a time still fits before closing.",
  ),
  buffer_minutes: z.number().describe(
    "Free time kept after every appointment. The next one can only start this many minutes after the previous one ends.",
  ),
  services: z.array(
    z.object({
      name: z.string(),
      minutes: z.number(),
      price: z.number().nullable().describe(
        "What it costs. Null means the business has not priced it — say you will confirm, never guess a number.",
      ),
    }),
  ).describe(
    "What this business offers, how long each takes and what it costs. WHEN THIS LIST IS NOT EMPTY, `book_appointment` accepts only these names: offer them by name, pass the name you agreed on, and never invent a duration or a price.",
  ),
  days: z.array(DaySchema),
});

async function listImplementation(
  input: z.infer<typeof ListInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof ListOutputSchema>> {
  const timeZone = timezoneOf(context);
  const config = appointmentsConfigOf(context);

  // Repetido nas duas saídas porque o modelo precisa da duração mesmo quando
  // não há dia nenhum para mostrar: é com ela que ele decide o que oferecer.
  const header = {
    default_duration_minutes: fallbackMinutes(config),
    buffer_minutes: config.buffer_minutes ?? 0,
    services: (config.services ?? []).map((service) => ({
      name: service.name,
      minutes: service.minutes,
      price: service.price ?? null,
    })),
  };

  const from = localToUtc(`${input.date} 00:00`, timeZone);

  if (!from) return { ...header, days: [] };

  // Um intervalo, e não um dia, porque "quando vocês têm livre?" é a pergunta
  // mais comum e era a mais cara: o modelo consultava dia a dia, uma ida ao
  // provedor por dia, e uma cliente ficou sem resposta enquanto ele varria a
  // semana. Catorze dias no máximo — além disso o cliente não está mais
  // escolhendo horário, está navegando. - 2026/08/02
  const lastRequested = input.until
    ? localToUtc(`${input.until} 00:00`, timeZone)
    : from;

  const last = lastRequested && lastRequested > from ? lastRequested : from;

  const dayCount = Math.min(
    14,
    Math.round((last.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1,
  );

  const to = new Date(from.getTime() + dayCount * 24 * 60 * 60 * 1000);
  const hours = businessHoursOf(context);

  // Uma consulta ao banco para o intervalo inteiro, repartida em memória.
  const { data } = await supabaseClient
    .from("appointments")
    .select("starts_at, duration_minutes, title")
    .eq("organization_id", context.organization.id)
    .eq("status", "scheduled")
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true });

  const days = [];

  for (let index = 0; index < dayCount; index++) {
    const start = new Date(from.getTime() + index * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    // Meio-dia, e não meia-noite: perguntar "abre neste dia" à meia-noite
    // responderia "não" para toda loja que abre às 9h.
    const noon = new Date(start.getTime() + 12 * 60 * 60 * 1000);
    const range = hours?.[wallClockDayIndex(noon, timeZone)];

    days.push({
      date: utcToLocal(noon, timeZone).slice(0, 10),
      weekday: weekdayOf(noon, timeZone),
      open: hours ? isOpenAt(hours, timeZone, noon) : true,
      // O horário do dia junto: sem ele o modelo teria de lembrar a tabela da
      // semana para saber até que horas pode oferecer.
      opens_at: range?.from ?? null,
      closes_at: range?.to ?? null,
      taken: (data ?? [])
        .filter((row) => {
          const at = new Date(row.starts_at as string);
          return at >= start && at < end;
        })
        .map((row) => ({
          starts_at: utcToLocal(new Date(row.starts_at as string), timeZone)
            .slice(11),
          duration_minutes: (row.duration_minutes as number | null) ?? null,
          title: row.title as string,
        })),
    });
  }

  return { ...header, days };
}

export const ListAppointmentsTool: ToolDefinition<
  typeof ListInputSchema,
  typeof ListOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "list_appointments",
  // "for your eyes only" entrou em 2026/08/09: o modelo repassou a agenda ao
  // cliente — "10:40 já está reservado" — ao oferecer horários. `taken` é a
  // agenda da casa, com nome de quem marcou; serve para NÃO oferecer aquela
  // hora, e nunca para contar o que tem nela.
  description:
    "See what is already booked, and when the business opens. Call this BEFORE offering times, so you never offer a taken slot or a closed day. Pass `until` to cover a range in ONE call whenever the customer asks about more than one day — asking day by day is slow and the customer waits. It returns every booking of the business, not only this customer's. WHAT IT RETURNS IS FOR YOUR EYES ONLY: `taken` is the business's private schedule and carries other customers' bookings. Use it to pick free times to offer — never repeat it, never say which hours are taken or busy, never mention the gaps between bookings. The customer hears only the times they can have.",
  inputSchema: z.toJSONSchema(ListInputSchema),
  outputSchema: z.toJSONSchema(ListOutputSchema),
  implementation: listImplementation,
};

// ---------------------------------------------------------------------------
// Marcar
// ---------------------------------------------------------------------------

const BookInputSchema = z.object({
  title: z.string().describe(
    "What the appointment is for, in the customer's own words — 'corte de cabelo', 'consulta de retorno'. WRITE IT IN THE LANGUAGE OF THE CONVERSATION: it is read by the business's staff in their agenda.",
  ),
  starts_at: z.string().describe(
    "When, as 'YYYY-MM-DD HH:MM' in the business's own timezone. Never convert to UTC — send the wall-clock time you agreed with the customer.",
  ),
  service: z.string().optional().describe(
    "Which service, by the name `list_appointments` gave you. Required when that list is not empty — it is what says how long the appointment takes.",
  ),
  duration_minutes: z.number().int().positive().optional().describe(
    "How long it takes. Omit if you do not know; do not invent one. Ignored when the business lists its services: there the duration comes from the service.",
  ),
  notes: z.string().optional().describe(
    "Anything the staff should know before the customer arrives. Optional.",
  ),
  professional: z.string().optional().describe(
    "Who should take it, by name, ONLY when the customer asked for someone in particular ('com o Jorge'). Leave it out otherwise and the business picks whoever is free — never ask the customer to choose a person they did not bring up.",
  ),
});

const BookOutputSchema = z.object({
  booked: z.boolean(),
  professional: z.string().nullable().describe(
    "Who is taking it. Say this name when confirming — a customer told 'booked for Tuesday 10:00' in a four-chair shop still does not know who will attend them. Null when the business has nobody registered, and then say nothing about who.",
  ),
  starts_at: z.string().nullable().describe("Local time actually recorded."),
  weekday: z.string().nullable().describe(
    "Which day of the week that is. Use THIS when confirming to the customer — do not work it out yourself.",
  ),
  reminder_at: z.string().nullable().describe(
    "When the customer will be reminded, local time, or null when no reminder was scheduled.",
  ),
  price: z.number().nullable().describe(
    "What was recorded for this appointment, from the business's own price list. Null means it is not priced — do not quote a figure of your own.",
  ),
  refused: z.string().nullable().describe(
    "Why it could not be booked. Tell the customer this reason and offer another time.",
  ),
});

/**
 * O lembrete, criado junto com o compromisso.
 *
 * Mesma mecânica da tela: uma mensagem de saída gravada com data futura, que o
 * despachante só recolhe quando a hora chega. Não é máquina nova, é a que já
 * existia.
 *
 * A quantidade de variáveis do modelo vem da configuração, gravada quando
 * alguém escolheu o modelo na tela. Perguntar à Meta aqui custaria uma ida à
 * rede em cada agendamento para descobrir algo que já era sabido.
 */
async function scheduleReminder(
  context: RequestContext,
  supabaseClient: SupabaseClient,
  startsAt: Date,
  timeZone: string,
): Promise<Date | null> {
  const extra = (context.organization.extra ?? {}) as OrganizationExtra;
  const config = extra.appointment_reminder;

  if (!config?.template) return null;

  const at = new Date(
    startsAt.getTime() - (config.hours_before ?? 24) * 60 * 60 * 1000,
  );

  if (at.getTime() <= Date.now()) return null;

  const local = utcToLocal(startsAt, timeZone);

  const values = [
    context.contact?.name || context.conversation.contact_address || "",
    local.slice(0, 10),
    local.slice(11),
  ].slice(0, config.variables ?? 0);

  const template: Record<string, unknown> = {
    name: config.template,
    language: { code: config.language || "pt_BR" },
  };

  if (values.length) {
    template.components = [
      {
        type: "body",
        parameters: values.map((text) => ({ type: "text", text })),
      },
    ];
  }

  const { error } = await supabaseClient.from("messages").insert({
    organization_id: context.organization.id,
    conversation_id: context.conversation.id,
    service: context.conversation.service,
    organization_address: context.conversation.organization_address,
    contact_address: context.conversation.contact_address,
    direction: "outgoing",
    content: {
      version: "1",
      type: "data",
      kind: "template",
      data: template,
      text: values.join(" · "),
    },
    timestamp: at.toISOString(),
  });

  // Um lembrete que não pôde ser gravado não derruba o agendamento: o
  // compromisso é o que importa, e a resposta diz que não haverá aviso.
  return error ? null : at;
}

/**
 * Um compromisso já marcado que se sobrepõe a este.
 *
 * Comparar só o instante de início não basta, e a primeira simulação mostrou
 * por quê: uma limpeza de uma hora às 10h e outra às 10h30 passavam as duas,
 * porque os `starts_at` são diferentes. Duas pessoas na mesma cadeira.
 *
 * A conta em si é do `findOverlap`, que não toca no banco e por isso pode ser
 * testado. Aqui fica só a janela de busca. - 2026/08/02
 */
export type Professional = {
  id: string;
  name: string;
  extra?: { services?: string[] } | null;
};

/** Quem está cadastrado e ativo. Lista vazia é negócio de uma pessoa só. */
export async function activeProfessionals(
  supabaseClient: SupabaseClient,
  organizationId: string,
): Promise<Professional[]> {
  const { data } = await supabaseClient
    .from("professionals")
    .select("id, name, extra")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("created_at");

  return (data ?? []) as Professional[];
}

/**
 * Se esta pessoa faz este serviço.
 *
 * Lista vazia é "faz tudo", e não "não faz nada" — é o caso da maioria, e
 * obrigar a marcar oito serviços para cadastrar o primeiro barbeiro faria
 * ninguém cadastrar nenhum.
 */
function atende(profissional: Professional, servico?: string | null): boolean {
  const lista = profissional.extra?.services ?? [];

  if (!lista.length || !servico) return true;

  return lista.some((nome) =>
    nome.trim().toLowerCase() === servico.trim().toLowerCase()
  );
}

/**
 * Quem está ocupado naquele horário — por pessoa, não pela loja.
 *
 * Até 2026/08/09 esta busca olhava só `organization_id`, e a consequência era
 * grande: numa barbearia de quatro cadeiras, o primeiro cliente marcava às 10h
 * e os outros três eram RECUSADOS — "esse horário já tem atendimento" — com
 * três barbeiros parados. Três quartos da capacidade perdidos, e a recusa
 * parecendo correta de fora.
 *
 * Sem ninguém cadastrado, o comportamento é o de antes: a loja é uma agenda só.
 * É o caso do salão de uma pessoa, que não tem por que cadastrar a si mesma.
 */
async function agendaOcupada(
  supabaseClient: SupabaseClient,
  organizationId: string,
  startsAt: Date,
  minutes: number,
) {
  const endsAt = new Date(startsAt.getTime() + minutes * 60 * 1000);

  // Uma janela generosa em volta, para não trazer o dia inteiro nem perder um
  // compromisso longo que começou antes.
  const from = new Date(startsAt.getTime() - 12 * 60 * 60 * 1000);
  const to = new Date(endsAt.getTime() + 12 * 60 * 60 * 1000);

  const { data } = await supabaseClient
    .from("appointments")
    .select("starts_at, duration_minutes, professional_id")
    .eq("organization_id", organizationId)
    .eq("status", "scheduled")
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString());

  return (data ?? []) as {
    starts_at: string;
    duration_minutes: number | null;
    professional_id: string | null;
  }[];
}

async function findConflict(
  supabaseClient: SupabaseClient,
  organizationId: string,
  startsAt: Date,
  minutes: number,
  config: AppointmentsConfig,
): Promise<Date | null> {
  const marcados = await agendaOcupada(
    supabaseClient,
    organizationId,
    startsAt,
    minutes,
  );

  return findOverlap(marcados, startsAt, minutes, config);
}

/**
 * Quem pode pegar este horário, entre os cadastrados.
 *
 * Devolve a pessoa escolhida, ou `null` quando ninguém está livre. Escolhe
 * quem tem MENOS compromissos naquele dia: sem isso a fila inteira cai no
 * primeiro da lista, e o quarto barbeiro passa o dia olhando o primeiro
 * trabalhar.
 */
async function escolherProfissional(
  supabaseClient: SupabaseClient,
  organizationId: string,
  startsAt: Date,
  minutes: number,
  config: AppointmentsConfig,
  candidatos: Professional[],
): Promise<{ escolhido: Professional | null; conflito: Date | null }> {
  const marcados = await agendaOcupada(
    supabaseClient,
    organizationId,
    startsAt,
    minutes,
  );

  const doDia = (id: string) =>
    marcados.filter((m) =>
      m.professional_id === id &&
      m.starts_at.slice(0, 10) === startsAt.toISOString().slice(0, 10)
    ).length;

  let primeiroConflito: Date | null = null;

  const livres = candidatos.filter((pessoa) => {
    const conflito = findOverlap(
      marcados.filter((m) => m.professional_id === pessoa.id),
      startsAt,
      minutes,
      config,
    );

    if (conflito && !primeiroConflito) primeiroConflito = conflito;

    return !conflito;
  });

  if (!livres.length) return { escolhido: null, conflito: primeiroConflito };

  const escolhido = livres
    .slice()
    .sort((a, b) => doDia(a.id) - doDia(b.id))[0];

  return { escolhido, conflito: null };
}

async function bookImplementation(
  input: z.infer<typeof BookInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof BookOutputSchema>> {
  const timeZone = timezoneOf(context);

  // A recusa carrega a data de hoje. Um modelo pequeno erra "quinta-feira" e
  // manda uma data da semana passada; recebendo só "está no passado" ele
  // repete o erro, e foi exatamente o que a segunda simulação mostrou — sete
  // turnos tentando marcar num dia que já tinha ido embora. Com a âncora, ele
  // tem como recalcular. - 2026/08/02
  const today = utcToLocal(new Date(), timeZone).slice(0, 10);

  const refuse = (reason: string) => ({
    booked: false,
    professional: null,
    starts_at: null,
    weekday: null,
    reminder_at: null,
    price: null,
    refused: `${reason} (today is ${today})`,
  });

  const startsAt = localToUtc(input.starts_at, timeZone);

  if (!startsAt) {
    return refuse("The date could not be read. Use 'YYYY-MM-DD HH:MM'.");
  }

  if (startsAt.getTime() <= Date.now()) {
    return refuse("That time is in the past.");
  }

  const config = appointmentsConfigOf(context);
  const minutes = minutesFor(input, config);

  if (minutes === null) {
    return refuse(
      `"${
        input.service ?? input.title
      }" is not one of the services this business offers. Ask the customer to pick one of: ${
        (config.services ?? []).map((service) => service.name).join(", ")
      }.`,
    );
  }

  const hours = businessHoursOf(context);

  if (hours && !fitsOpeningHours(hours, timeZone, startsAt, minutes)) {
    return refuse(
      `The business is not open for the whole appointment — it takes ${minutes} minutes from that time.`,
    );
  }

  if (!context.conversation.contact_address) {
    return refuse("This conversation has no phone number to book for.");
  }

  /**
   * Com gente cadastrada, o horário é de uma pessoa; sem, é da loja.
   *
   * O caminho de baixo é o de antes, palavra por palavra, e vale para o negócio
   * de uma pessoa só — que não tem por que cadastrar a si mesma.
   */
  const equipe = await activeProfessionals(
    supabaseClient,
    context.organization.id,
  );

  let profissional: Professional | null = null;

  if (equipe.length) {
    const pedido = input.professional?.trim().toLowerCase();

    const candidatos = equipe
      .filter((pessoa) =>
        !pedido || pessoa.name.trim().toLowerCase().includes(pedido)
      )
      .filter((pessoa) => atende(pessoa, input.service));

    if (pedido && !candidatos.length) {
      return refuse(
        `Nobody called "${input.professional}" takes that service here. Who works here: ${
          equipe.map((pessoa) => pessoa.name).join(", ")
        }.`,
      );
    }

    if (!candidatos.length) {
      return refuse(
        `Nobody here takes "${input.service}". Ask the customer to pick another service.`,
      );
    }

    const { escolhido, conflito } = await escolherProfissional(
      supabaseClient,
      context.organization.id,
      startsAt,
      minutes,
      config,
      candidatos,
    );

    if (!escolhido) {
      return refuse(
        `Everyone who takes that service is busy then${
          conflito
            ? ` — the clash starts at ${utcToLocal(conflito, timeZone).slice(11)}`
            : ""
        }. Offer another time.`,
      );
    }

    profissional = escolhido;
  } else {
    const conflict = await findConflict(
      supabaseClient,
      context.organization.id,
      startsAt,
      minutes,
      config,
    );

    if (conflict) {
      return refuse(
        `That time overlaps an appointment already booked at ${
          utcToLocal(conflict, timeZone).slice(11)
        }. Offer another time.`,
      );
    }
  }

  const { data, error } = await supabaseClient
    .from("appointments")
    .insert({
      organization_id: context.organization.id,
      service: context.conversation.service,
      organization_address: context.conversation.organization_address,
      contact_address: context.conversation.contact_address,
      conversation_id: context.conversation.id,
      title: input.title,
      starts_at: startsAt.toISOString(),
      // A duração resolvida, e não a que veio na chamada: é ela que reservou o
      // espaço, e gravar `null` obrigaria todo mundo a adivinhar de novo
      // depois — inclusive a tela da agenda, que mostraria "sem duração" para
      // um compromisso de duas horas. Vale igual para o preço.
      duration_minutes: minutes,
      price: priceFor(input, config),
      notes: input.notes ?? null,
      professional_id: profissional?.id ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    return refuse("The appointment could not be saved.");
  }

  const reminderAt = await scheduleReminder(
    context,
    supabaseClient,
    startsAt,
    timeZone,
  );

  return {
    booked: true,
    professional: profissional?.name ?? null,
    starts_at: utcToLocal(startsAt, timeZone),
    weekday: weekdayOf(startsAt, timeZone),
    reminder_at: reminderAt ? utcToLocal(reminderAt, timeZone) : null,
    price: (data.price as number | null) ?? null,
    refused: null,
  };
}

export const BookAppointmentTool: ToolDefinition<
  typeof BookInputSchema,
  typeof BookOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "book_appointment",
  description:
    "Book an appointment for the person you are talking to. The customer is taken from this conversation — you cannot book for anybody else, and there is no phone number to pass. Check `list_appointments` first. If it comes back refused, tell the customer the reason and offer another time; never claim it is booked when it is not. ALWAYS REPLY TO THE CUSTOMER IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(BookInputSchema),
  outputSchema: z.toJSONSchema(BookOutputSchema),
  implementation: bookImplementation,
};

// ---------------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------------

const CancelInputSchema = z.object({
  starts_at: z.string().describe(
    "When the appointment starts, as 'YYYY-MM-DD HH:MM' in the business's own timezone.",
  ),
});

const CancelOutputSchema = z.object({
  cancelled: z.boolean(),
  refused: z.string().nullable(),
});

async function cancelImplementation(
  input: z.infer<typeof CancelInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof CancelOutputSchema>> {
  const timeZone = timezoneOf(context);
  const startsAt = localToUtc(input.starts_at, timeZone);

  if (!startsAt) {
    return {
      cancelled: false,
      refused: `The date could not be read. Use 'YYYY-MM-DD HH:MM'. (today is ${
        utcToLocal(new Date(), timeZone).slice(0, 10)
      })`,
    };
  }

  // Limitado ao contato desta conversa: cancelar o compromisso de outra pessoa
  // é o pior estrago que esta ferramenta poderia fazer.
  const { data } = await supabaseClient
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("organization_id", context.organization.id)
    .eq("contact_address", context.conversation.contact_address ?? "")
    .eq("starts_at", startsAt.toISOString())
    .eq("status", "scheduled")
    .select("id");

  if (!data?.length) {
    return {
      cancelled: false,
      refused: "No appointment of yours was found at that time.",
    };
  }

  return { cancelled: true, refused: null };
}

export const CancelAppointmentTool: ToolDefinition<
  typeof CancelInputSchema,
  typeof CancelOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "cancel_appointment",
  description:
    "Cancel an appointment of the person you are talking to. Only their own appointments can be cancelled. Confirm the day and time with the customer before calling this. ALWAYS REPLY TO THE CUSTOMER IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(CancelInputSchema),
  outputSchema: z.toJSONSchema(CancelOutputSchema),
  implementation: cancelImplementation,
};

// ---------------------------------------------------------------------------
// Remarcar
// ---------------------------------------------------------------------------

/**
 * Mover um compromisso, em vez de marcar outro por cima.
 *
 * Sem esta ferramenta o modelo não tinha como atender "pode ser 10h30 em vez
 * de 10h": ele chamava `book_appointment` de novo e o cliente ficava com dois
 * horários, um deles fantasma. Foi o que a primeira simulação produziu — e
 * nenhuma instrução de prompt conserta a falta de um verbo. - 2026/08/02
 */
const RescheduleInputSchema = z.object({
  from: z.string().describe(
    "The appointment's current start, as 'YYYY-MM-DD HH:MM' in the business's own timezone.",
  ),
  to: z.string().describe(
    "The new start, same format. The appointment keeps its title and duration.",
  ),
});

const RescheduleOutputSchema = z.object({
  rescheduled: z.boolean(),
  starts_at: z.string().nullable(),
  weekday: z.string().nullable().describe(
    "Which day of the week the new time falls on. Use THIS when confirming.",
  ),
  refused: z.string().nullable(),
});

async function rescheduleImplementation(
  input: z.infer<typeof RescheduleInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof RescheduleOutputSchema>> {
  const timeZone = timezoneOf(context);

  const today = utcToLocal(new Date(), timeZone).slice(0, 10);

  const refuse = (reason: string) => ({
    rescheduled: false,
    starts_at: null,
    weekday: null,
    refused: `${reason} (today is ${today})`,
  });

  const from = localToUtc(input.from, timeZone);
  const to = localToUtc(input.to, timeZone);

  if (!from || !to) {
    return refuse("A date could not be read. Use 'YYYY-MM-DD HH:MM'.");
  }

  if (to.getTime() <= Date.now()) {
    return refuse("The new time is in the past.");
  }

  // Só os desta conversa: mover o compromisso de outra pessoa seria o mesmo
  // estrago que cancelar o dela.
  const { data: mine } = await supabaseClient
    .from("appointments")
    .select("id, duration_minutes")
    .eq("organization_id", context.organization.id)
    .eq("contact_address", context.conversation.contact_address ?? "")
    .eq("starts_at", from.toISOString())
    .eq("status", "scheduled")
    .limit(1);

  const appointment = mine?.[0];

  if (!appointment) {
    return refuse("No appointment of yours was found at that time.");
  }

  const config = appointmentsConfigOf(context);

  // A duração é a que já estava gravada: remarcar move o compromisso, não o
  // troca por outro. Conferida contra o horário só depois de encontrá-lo, para
  // não recusar por tamanho um compromisso que nem é desta pessoa.
  const minutes = (appointment.duration_minutes as number | null) ??
    fallbackMinutes(config);

  const hours = businessHoursOf(context);

  if (hours && !fitsOpeningHours(hours, timeZone, to, minutes)) {
    return refuse(
      `The business is not open for the whole appointment at the new time — it takes ${minutes} minutes.`,
    );
  }

  const conflict = await findConflict(
    supabaseClient,
    context.organization.id,
    to,
    minutes,
    config,
  );

  // O próprio compromisso não conta como conflito consigo mesmo.
  if (conflict && conflict.getTime() !== from.getTime()) {
    return refuse(
      `The new time overlaps an appointment already booked at ${
        utcToLocal(conflict, timeZone).slice(11)
      }. Offer another time.`,
    );
  }

  await supabaseClient
    .from("appointments")
    .update({ starts_at: to.toISOString() })
    .eq("id", appointment.id as string);

  return {
    rescheduled: true,
    starts_at: utcToLocal(to, timeZone),
    weekday: weekdayOf(to, timeZone),
    refused: null,
  };
}

export const RescheduleAppointmentTool: ToolDefinition<
  typeof RescheduleInputSchema,
  typeof RescheduleOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "reschedule_appointment",
  description:
    "Move an existing appointment of the person you are talking to, to a new day or time. USE THIS instead of booking again when the customer changes their mind about a time they already have — booking again leaves them with two appointments. ALWAYS REPLY TO THE CUSTOMER IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(RescheduleInputSchema),
  outputSchema: z.toJSONSchema(RescheduleOutputSchema),
  implementation: rescheduleImplementation,
};
