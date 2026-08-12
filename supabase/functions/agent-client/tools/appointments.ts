import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import { DEFAULT_TIMEZONE, isOpenAt } from "../protocols/context.ts";
import { convidarDaFila } from "./waitlist.ts";
import { profissionalDoNumero } from "./staff.ts";
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

  if (!isOpenAt(hours, timeZone, lastMoment)) return false;

  /**
   * E não pode ATRAVESSAR o almoço, mesmo com as duas pontas abertas.
   *
   * Conferir só o começo e o fim bastava enquanto o expediente era um bloco só.
   * Com o buraco do meio deixa de bastar: um corte com barba das 11h30 às 13h30
   * começa aberto, termina aberto, e passa por cima da hora em que não tem
   * ninguém na loja. O cliente ficaria uma hora sozinho na cadeira.
   *
   * Meia em meia hora porque é o passo em que os horários são oferecidos —
   * varrer minuto a minuto custaria sessenta vezes mais para responder a mesma
   * pergunta. Um almoço mais curto que meia hora escaparia; nunca vi um.
   * - 2026/08/10
   */
  for (
    let instante = startsAt.getTime() + 30 * 60 * 1000;
    instante < lastMoment.getTime();
    instante += 30 * 60 * 1000
  ) {
    if (!isOpenAt(hours, timeZone, new Date(instante))) return false;
  }

  return true;
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
  // Sem o serviço, `free` é calculado com a duração padrão — e um corte de uma
  // hora oferecido numa vaga de meia acaba recusado no agendamento.
  service: z.string().optional().describe(
    "The service the customer asked for, when they named one. Pass it so `free` is computed with that service's real duration: a one-hour service does not fit every slot a fifteen-minute one fits.",
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
  /**
   * A resposta pronta, e não as peças da resposta.
   *
   * `taken`, `away`, `opens_at` e a semana de cada pessoa continuam abaixo
   * porque respondem outras perguntas — de quem é aquele compromisso, quem
   * trabalha na terça. Mas nenhuma delas precisa mais ser subtraída para
   * oferecer um horário: isto aqui já é o resultado. - 2026/08/10
   */
  free: z.string().describe(
    "THE TIMES YOU CAN OFFER, space-separated, in the business's own timezone — already computed from the opening hours, each person's own hours, time off, bookings, service duration and the gap between appointments. Use this and only this when offering a time; never work one out from the other fields. Empty means nothing that day. Times already past are gone from here.",
  ),
  free_per_person: z.record(z.string(), z.string()).nullable().describe(
    "Only the people whose free times DIFFER from `free` — someone who starts at 13:00, or is off in the afternoon. Their value is their own space-separated list, or 'none' when they have nothing that day. Anyone absent from here can take ANY time in `free`. This is the answer when the customer names a person.",
  ),
  /**
   * A agenda de quem escreve, e SÓ dela — quando quem escreve trabalha aqui.
   *
   * Existe porque pedir ao modelo que troque de ferramenta não funcionou.
   * Medido em 2026/08/11: o barbeiro perguntou quem tinha marcado com ele, o
   * modelo chamou `list_appointments`, não achou a resposta ali, e transferiu
   * para uma pessoa — duas vezes — em vez de chamar `my_schedule`, que estava
   * ligada e descrita. Escolher entre duas ferramentas é uma decisão, e toda
   * decisão que eu deixei com o modelo hoje voltou como defeito.
   *
   * Então a resposta vem junto. Quem confere se a pessoa é da casa continua
   * sendo o código, pelo número — a mesma conferência de `my_schedule`, no
   * mesmo lugar de sempre. Para um cliente, isto simplesmente não existe.
   */
  your_bookings: z.array(
    z.object({
      starts_at: z.string().describe("Local time, HH:MM."),
      title: z.string(),
      customer: z.string().nullable(),
    }),
  ).nullable().describe(
    "The bookings of the person WRITING, when the number they write from belongs to somebody on the team. Null for everybody else, which is almost everybody — a customer must never be told who is booked. When it is present, this is what they are asking about: answer from it.",
  ),
  away: z.array(
    z.object({
      from: z.string().describe("Local time it starts, 'YYYY-MM-DD HH:MM'."),
      to: z.string().describe(
        // Medido em 2026/08/09: um cliente pediu 13:00 e foi recusado porque o
        // bloqueio terminava às 13:00 — e a hora estava livre.
        "Local time it ends, and the end is OPEN: somebody away 'until 13:00' is back at 13:00.",
      ),
      professional: z.string().nullable().describe(
        "Who is away. NULL MEANS THE WHOLE BUSINESS — a holiday or a closure — and then nobody can be booked in that window.",
      ),
    }),
  ).describe(
    // O motivo da folga não desce até aqui de propósito — o dentista do Jorge
    // não é assunto do cliente.
    "Time off: hours nobody is there, on top of the regular week. NEVER tell the customer WHY somebody is away — 'não temos nesse horário' is the whole answer.",
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
  who_works_here: z.array(
    z.object({
      name: z.string(),
      days: z.record(z.string(), z.string()).nullable().describe(
        "Their own weekly hours, when they differ from the shop's. Null means they follow the shop. NEVER offer this person a time outside these days and hours — booking will refuse it and the customer will have been promised something twice.",
      ),
    }),
  ).optional().describe(
    "The people who attend here. Absent in a one-person business, and then say nothing about who attends.",
  ),
  about_availability: z.string().optional(),
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
    .select("starts_at, duration_minutes, title, professional_id, notes")
    .eq("organization_id", context.organization.id)
    .eq("status", "scheduled")
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true });

  /**
   * Quem atende, e de quem é cada compromisso.
   *
   * Sem isto o modelo não tem como responder "quem tá livre terça?" — e foi o
   * que aconteceu no WhatsApp de verdade em 2026/08/09: perguntado quem estava
   * disponível, ele devolveu HORÁRIOS, porque horário era tudo o que esta
   * ferramenta lhe dava. O nome dos quatro estava no contexto e não bastava: a
   * pergunta é sobre o cruzamento dos dois, e o cruzamento mora aqui.
   *
   * Vale a mesma regra do resto do retorno: é para os olhos dele. Dizer ao
   * cliente que "o Jorge está com a agenda cheia" é contar a agenda da casa.
   * - 2026/08/09
   */
  const equipe = await activeProfessionals(
    supabaseClient,
    context.organization.id,
  );

  const nomeDoProfissional = new Map(equipe.map((p) => [p.id, p.name]));

  /**
   * As folgas do intervalo consultado, para ele não oferecer o que será
   * recusado.
   *
   * Sem isto o cliente ouve duas coisas contrárias em dois minutos: "tem quinta
   * às 14h com o Jorge" e, logo depois, "esse horário não está disponível".
   * Aparecem como bloco ocupado, com o nome de quem está de folga — e SEM o
   * motivo, que não desce até aqui de propósito.
   */
  const { data: folgasDoPeriodo } = await supabaseClient
    .from("time_off")
    .select("professional_id, starts_at, ends_at")
    .eq("organization_id", context.organization.id)
    .lt("starts_at", to.toISOString())
    .gt("ends_at", from.toISOString());

  const days = [];

  /**
   * Quem escreve é da casa? A mesma conferência de sempre, pelo número.
   *
   * Uma vez, fora do laço dos dias: é a resposta para a conversa inteira, e
   * repeti-la por dia seria a mesma pergunta catorze vezes.
   */
  const daCasa = profissionalDoNumero(
    equipe,
    context.conversation.contact_address,
  );

  const minhasReservas = (comeco: Date, fim: Date) => {
    if (!daCasa) return null;

    return (data ?? [])
      .filter((row) => {
        const at = new Date(row.starts_at as string);

        return at >= comeco && at < fim &&
          row.professional_id === daCasa.id;
      })
      .map((row) => ({
        starts_at: utcToLocal(new Date(row.starts_at as string), timeZone)
          .slice(11),
        title: row.title as string,
        customer:
          (row.notes as string | null)?.match(/cliente:?\s*([^\n·|]+)/i)?.[1]
            ?.trim() ?? null,
      }));
  };

  // A duração de verdade quando o cliente nomeou o serviço: uma vaga de meia
  // hora não serve para um corte com barba, e oferecê-la é oferecer o que o
  // agendamento recusa em seguida.
  const servico = input.service
    ? serviceIn(config.services ?? [], { service: input.service })
    : undefined;

  const duracao = servico?.minutes ?? fallbackMinutes(config);
  const agora = new Date();

  for (let index = 0; index < dayCount; index++) {
    const start = new Date(from.getTime() + index * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    // Meio-dia, e não meia-noite: perguntar "abre neste dia" à meia-noite
    // responderia "não" para toda loja que abre às 9h.
    const noon = new Date(start.getTime() + 12 * 60 * 60 * 1000);
    const range = hours?.[wallClockDayIndex(noon, timeZone)];
    const date = utcToLocal(noon, timeZone).slice(0, 10);

    /**
     * O feriado fecha o dia, e não o deixa aberto e vazio.
     *
     * A folga da casa inteira chegava como um bloco a mais, com o dia ainda
     * dizendo `open: true` das 9h às 19h — duas coisas contrárias na mesma
     * resposta. Medido em 2026/08/10: num feriado, o agendamento recusou
     * corretamente e a frase seguinte ofereceu "14h, 15h ou 16h na quinta".
     * Horários inventados num dia em que ninguém abre a porta, e o cliente sem
     * como saber.
     *
     * Fecha só quando a folga cobre o expediente inteiro. Uma tarde bloqueada
     * não é dia fechado — ali `free` já responde sozinho, e dizer "fechado"
     * mandaria embora quem cabia de manhã. - 2026/08/10
     */
    const abertura = range?.from
      ? localToUtc(`${date} ${range.from}`, timeZone)
      : null;

    const fechamento = range?.to
      ? localToUtc(`${date} ${range.to}`, timeZone)
      : null;

    const feriado = !!abertura && !!fechamento &&
      (folgasDoPeriodo ?? []).some((folga) =>
        !folga.professional_id &&
        new Date(folga.starts_at as string) <= abertura &&
        new Date(folga.ends_at as string) >= fechamento
      );

    /**
     * "A casa abre neste dia" é ter linha na semana — não estar aberta agora.
     *
     * Isto perguntava `isOpenAt` ao MEIO-DIA, como jeito de não perguntar à
     * meia-noite (que responderia "fechado" para toda loja que abre às 9h). No
     * dia em que o almoço passou a existir, meio-dia virou justamente a hora em
     * que não tem ninguém — e a primeira barbearia com almoço das 12h às 13h
     * teve a semana inteira marcada como fechada. Medido em 2026/08/10: `open`
     * falso e `free` vazio em todos os dias, com a loja aberta 9h às 19h.
     *
     * A linha da semana responde a pergunta certa e não depende de escolher uma
     * hora de sondagem que amanhã pode ser feriado, almoço ou o que vier.
     */
    const aberto = (hours ? !!range : true) && !feriado;

    const { livres, porPessoa } = aberto
      ? horariosLivres({
        date,
        abre: range?.from ?? null,
        fecha: range?.to ?? null,
        timeZone,
        minutes: duracao,
        config,
        horarioDaLoja: hours ?? undefined,
        equipe,
        folgas: (folgasDoPeriodo ?? []) as Folga[],
        marcados: (data ?? []) as {
          starts_at: string;
          duration_minutes: number | null;
          professional_id: string | null;
        }[],
        agora,
        servico: input.service ?? null,
      })
      : { livres: [], porPessoa: null };

    days.push({
      date,
      weekday: weekdayOf(noon, timeZone),
      open: aberto,
      // O horário do dia junto: sem ele o modelo teria de lembrar a tabela da
      // semana para saber até que horas pode oferecer.
      opens_at: range?.from ?? null,
      closes_at: range?.to ?? null,
      free: livres.join(" "),
      free_per_person: porPessoa,
      /**
       * `taken` saiu daqui em 2026/08/11, e é a lição do dia inteiro.
       *
       * Ele listava todo compromisso do dia, com hora, serviço e dono. A ideia
       * era responder "de quem é aquela reserva" — pergunta que um cliente
       * nunca deve ouvir respondida, e que a equipe agora faz por
       * `your_bookings`.
       *
       * O preço era alto e voltou três vezes: com `free` dizendo "11:00 livre"
       * e `taken` mostrando um dos quatro barbeiros ocupado às 11h, a resposta
       * saiu "11h já está ocupado". Medido em 2026/08/09, 08/10 e de novo em
       * 08/11, DEPOIS de `free` existir e DEPOIS de a regra estar escrita em
       * primeiro lugar na lista.
       *
       * Eu tinha tirado a necessidade de calcular e deixado a tentação na
       * mesa. Enquanto os dois números estiverem lado a lado, um deles vai ser
       * lido — e o errado é o mais chamativo. Instrução não compete com dado
       * na cara: some com o dado.
       */
      your_bookings: minhasReservas(start, end),
      // Folgas do dia, na mesma forma de "ocupado": para quem oferece horário,
      // folga e compromisso são a mesma coisa — hora que não dá.
      away: (folgasDoPeriodo ?? [])
        .filter((folga) => {
          const inicio = new Date(folga.starts_at as string);
          const fim = new Date(folga.ends_at as string);

          return inicio < end && fim > start;
        })
        .map((folga) => ({
          from: utcToLocal(new Date(folga.starts_at as string), timeZone),
          to: utcToLocal(new Date(folga.ends_at as string), timeZone),
          professional: folga.professional_id
            ? nomeDoProfissional.get(folga.professional_id as string) ?? null
            : null,
        })),
    });
  }

  return {
    ...header,
    ...(equipe.length
      ? {
        who_works_here: equipe.map((pessoa) => ({
          name: pessoa.name,
          // Só de quem tem horário próprio. Repetir a semana da loja em cada
          // nome encheria o contexto com a mesma informação quatro vezes.
          days: semanaDe(pessoa),
        })),
        // "diga quem PODE" em vez de "não diga quem não pode": a primeira
        // redação proibia contar quem está ocupado e mesmo assim saiu
        // "Jorge está ocupado às 9h, mas Marcos, Rafa e Duda têm
        // disponibilidade" — medido em 2026/08/09. Nomear só o lado
        // disponível responde a mesma pergunta sem abrir a agenda de
        // ninguém.
        // Vale também quando o cliente nomeia a PESSOA, e essa parte faltava.
        // Medido em 2026/08/10: pediram 14h com o Jorge, que trabalha
        // 13:00–19:00 naquele dia e não tinha nada marcado. A resposta foi "o
        // Jorge só começa a atender a partir das 13h" e, na mesma frase, "que
        // tal 13h ou 14h com ele?" — recusou e ofereceu a mesma hora, sem
        // nunca chamar a ferramenta que sabe responder. Ler `who_works_here` e
        // `away` para decidir é refazer à mão a conta que o `book_appointment`
        // já faz certo.
        about_availability: REGRAS_DA_AGENDA,
      }
      : {}),
    days,
  };
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
    "What can be offered, and when the business opens. Call this BEFORE offering any time. Pass `until` to cover a range in ONE call whenever they ask about more than one day — day by day is slow and they wait. WHAT IT RETURNS IS FOR YOUR EYES ONLY: the customer hears only the times they can have, never which hours are busy or how full a day is.",
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
  appointmentId: string,
): Promise<Date | null> {
  const extra = (context.organization.extra ?? {}) as OrganizationExtra;
  const config = extra.appointment_reminder;

  if (!config?.template) return null;

  const at = new Date(
    startsAt.getTime() - (config.hours_before ?? 24) * 60 * 60 * 1000,
  );

  if (at.getTime() <= Date.now()) return null;

  const local = utcToLocal(startsAt, timeZone);

  /**
   * O nome, e nunca o telefone no lugar dele.
   *
   * A primeira variável caía em `contact_address` quando a ficha não tinha
   * nome, e a ficha quase nunca tem: quem escreve "sou o Téo" no meio da
   * conversa não vira cadastro. Medido em 2026/08/10, num lembrete pronto para
   * sair: `"5511471962211"` na saudação. O cliente receberia o próprio número
   * de telefone como se fosse o nome dele.
   *
   * O nome da conversa é o do perfil do WhatsApp, que a pessoa mesma escolheu —
   * melhor palpite que existe aqui. Sem nenhum dos dois, vazio: um "olá," seco
   * é menos estranho que um telefone. - 2026/08/10
   */
  const nome = context.contact?.name?.trim() ||
    context.conversation.name?.trim() || "";

  // A data como gente escreve, não como o banco guarda. `2026-08-12` num
  // WhatsApp brasileiro é um valor de sistema vazando para o cliente.
  const [ano, mes, diaDoMes] = local.slice(0, 10).split("-");

  const values = [
    nome,
    `${diaDoMes}/${mes}/${ano}`,
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
      /**
       * O que o CLIENTE vai ler, e não a lista de variáveis.
       *
       * O painel mostra `content.text` na conversa. Enquanto isso era
       * `values.join(" · ")`, a loja via "Vinícius · 12/08/2026 · 09:52" no
       * lugar da mensagem — e quando o cliente respondia "confirmo", ninguém
       * sabia a quê. Medido em 2026/08/12, no primeiro lembrete entregue de
       * verdade: chegou certo no celular e chegou ilegível no painel.
       *
       * Sem corpo guardado — organização configurada antes disto existir —
       * volta a lista, mas rotulada. Ilegível com etiqueta ainda é melhor que
       * ilegível sem.
       */
      text: config.body
        ? values.reduce(
          (texto, valor, indice) =>
            texto.replaceAll(`{{${indice + 1}}}`, valor),
          config.body,
        )
        : `Lembrete · ${values.join(" · ")}`,
      /**
       * De qual compromisso este lembrete é.
       *
       * Sem isto, cancelar o compromisso deixava o lembrete de pé: o cliente
       * desmarcava e recebia, no dia seguinte, "seu horário é hoje às 15h" —
       * uma mensagem errada, PAGA, sobre algo que ele já tinha cancelado. E
       * remarcar deixava o lembrete do horário antigo.
       *
       * Uma chave no `content` e não uma coluna nova porque é isto que ela é:
       * parte do conteúdo daquela mensagem, lida só por quem a criou e por quem
       * precisa desfazê-la. - 2026/08/10
       */
      appointment_id: appointmentId,
    },
    timestamp: at.toISOString(),
  });

  // Um lembrete que não pôde ser gravado não derruba o agendamento: o
  // compromisso é o que importa, e a resposta diz que não haverá aviso.
  return error ? null : at;
}

/**
 * Apaga o lembrete de um compromisso que deixou de existir.
 *
 * Só o que ainda não saiu: `status->pending` é a marca de mensagem que espera a
 * hora chegar. Uma já enviada não se desfaz apagando a linha — o cliente já
 * leu, e sumir com o registro só apagaria a prova de que foi enviada.
 *
 * Falha em silêncio de propósito. Quem chama está cancelando ou remarcando um
 * compromisso, e o compromisso é o que importa: derrubar um cancelamento porque
 * o lembrete não saiu da fila seria trocar um erro pequeno por um grande.
 * - 2026/08/10
 */
async function cancelarLembretes(
  supabaseClient: SupabaseClient,
  appointmentIds: string[],
): Promise<void> {
  if (!appointmentIds.length) return;

  for (const id of appointmentIds) {
    await supabaseClient
      .from("messages")
      .delete()
      .eq("content->>appointment_id", id)
      .not("status->pending", "is", null);
  }
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
  extra?: {
    services?: string[];
    /** O horário dele. Ausente é "o mesmo da loja". */
    business_hours?: BusinessHours;
    /**
     * O WhatsApp dele, cadastrado pelo DONO.
     *
     * É a única prova de identidade que existe deste lado: "sou o Jorge" não
     * prova nada, e é por este número que `my_schedule` decide se entrega a
     * agenda do dia ou trata a pessoa como cliente. Ausente é o padrão, e é o
     * certo — a porta nasce fechada. - 2026/08/10
     */
    phone?: string;
    /** A conta com que ele entra na TELA. Não vale como identidade aqui. */
    agent_id?: string;
  } | null;
};

export type Folga = {
  professional_id: string | null;
  starts_at: string;
  ends_at: string;
};

/**
 * As folgas que tocam este intervalo.
 *
 * Uma janela generosa em volta pelo mesmo motivo dos compromissos: férias
 * começam dias antes e continuam valendo, e buscar só o dia perderia isso.
 */
async function folgasDe(
  supabaseClient: SupabaseClient,
  organizationId: string,
  startsAt: Date,
  minutes: number,
): Promise<Folga[]> {
  const endsAt = new Date(startsAt.getTime() + minutes * 60 * 1000);

  const { data } = await supabaseClient
    .from("time_off")
    .select("professional_id, starts_at, ends_at")
    .eq("organization_id", organizationId)
    .lt("starts_at", endsAt.toISOString())
    .gt("ends_at", startsAt.toISOString());

  return (data ?? []) as Folga[];
}

/**
 * Se alguma folga cobre este horário para esta pessoa.
 *
 * `professional_id` nulo na folga é a LOJA INTEIRA — feriado, reforma — e vale
 * para todo mundo. Preenchido, vale só para quem ela nomeia.
 *
 * Basta encostar: uma folga das 14h às 16h impede um corte que começa 15h30 e
 * termina 16h, porque metade dele cai dentro. Quem sai às 16h não corta cabelo
 * pela metade. - 2026/08/09
 */
function estaDeFolga(
  folgas: Folga[],
  profissionalId: string | null,
  startsAt: Date,
  minutes: number,
): boolean {
  const fim = new Date(startsAt.getTime() + minutes * 60 * 1000);

  return folgas.some((folga) => {
    if (folga.professional_id && folga.professional_id !== profissionalId) {
      return false;
    }

    return new Date(folga.starts_at) < fim &&
      new Date(folga.ends_at) > startsAt;
  });
}

/**
 * Se esta pessoa trabalha nesta hora.
 *
 * Sem horário próprio, vale o da loja — que é o caso da maioria, e obrigar a
 * repetir a semana em cada cadastro faria ninguém cadastrar.
 *
 * Com horário próprio, vale a INTERSEÇÃO: quem entra às 13h não atende às 10h
 * mesmo com a loja aberta, e ninguém atende domingo se a loja fecha domingo.
 * Deixar o profissional estender o horário da casa criaria o atendimento que
 * acontece com a porta trancada. - 2026/08/09
 */
/** Domingo primeiro, como o resto do sistema guarda a semana. */
const DIAS_DA_SEMANA = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** A semana desta pessoa, ou `null` quando ela segue a da loja. */
function semanaDe(profissional: Professional): Record<string, string> | null {
  const proprio = profissional.extra?.business_hours;

  if (!proprio?.some((dia) => !!dia)) return null;

  const semana: Record<string, string> = {};

  proprio.forEach((faixa, indice) => {
    semana[DIAS_DA_SEMANA[indice]] = faixa
      ? `${faixa.from}-${faixa.to}`
      : "closed";
  });

  return semana;
}

function trabalhaEm(
  profissional: Professional,
  horarioDaLoja: BusinessHours | undefined,
  timeZone: string,
  startsAt: Date,
  minutes: number,
): boolean {
  const proprio = profissional.extra?.business_hours;

  if (!proprio?.some((dia) => !!dia)) return true;

  if (!fitsOpeningHours(proprio, timeZone, startsAt, minutes)) return false;

  return !horarioDaLoja ||
    fitsOpeningHours(horarioDaLoja, timeZone, startsAt, minutes);
}

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

/**
 * As regras da agenda, cinco, na ordem do que custa mais errar.
 *
 * ## Por que curtas, e por que isto virou uma constante
 *
 * Este texto tinha 6.179 caracteres em 2026/08/10, ao fim de um dia em que
 * cada defeito medido virou mais um parágrafo aqui — sempre no fim, sempre em
 * caixa alta, sempre com a história da medição junto. Onze parágrafos
 * imperativos disputando a atenção do modelo.
 *
 * E as regras começaram a voltar. Na mesma tarde, com o texto no auge:
 *
 *   - `free` listava 11:00 e a resposta foi "11h já está ocupado"
 *   - `free` estava VAZIO e a resposta ofereceu "09:30, 13:00 ou 16:30"
 *
 * As duas são regras que estavam escritas ali, palavra por palavra, e que
 * tinham sido medidas funcionando quando entraram sozinhas. Instrução não se
 * acumula: cada acréscimo divide a atenção com os anteriores, e o décimo
 * parágrafo enfraquece o primeiro em vez de somar a ele.
 *
 * As histórias das medições saíram daqui e foram para os comentários, que é o
 * lugar delas: elas existem para o humano que vai mexer nisto entender por que
 * a regra existe e não apagá-la. O modelo precisa da regra.
 *
 * As medições que geraram cada uma, para quem vier depois:
 *
 *   1. 2026/08/09 e 08/10 — hora chamada de cheia porque um dos quatro
 *      barbeiros tinha compromisso nela; barbeiro recusado às 14:00 com turno
 *      13:00-19:00 e agenda vazia. Toda resposta errada veio de refazer à mão
 *      a conta que `free` já entrega.
 *   2. 2026/08/10 — dia fechado, `free` vazio, e a frase seguinte ofereceu
 *      "14h, 15h ou 16h na quinta". Três horários que não existiam. E, com o
 *      dia genuinamente cheio, 3 de 3 respostas corretas e nenhuma ofereceu a
 *      fila: a cadeira que vagou uma hora depois ficou vazia.
 *   3. 2026/08/10 — cliente pediu 13h, o modelo mandou 12:00 para o
 *      `book_appointment`, foi recusado, e respondeu com três opções em vez do
 *      agendamento que já tinha sido pedido. E "quarta dia 12" virou "dia 12
 *      de qual mês?", com a conversa morrendo ali.
 *   4. 2026/08/10 — barbeiro perguntou quem tinha marcado com ele e ouviu
 *      "não há nada marcado", com dois clientes na agenda: a resposta saiu
 *      desta ferramenta, que só sabe o que está LIVRE.
 *   5. 2026/08/09 — perguntado quem estava disponível, respondeu "o Jorge
 *      está ocupado às 9h, mas Marcos, Rafa e Duda têm disponibilidade".
 *      Abriu a agenda de quem ninguém perguntou.
 *
 * - 2026/08/11
 */
const REGRAS_DA_AGENDA = [
  "1. OFFER ONLY WHAT `free` SAYS. It is already computed from the opening hours, each person's own hours, time off, bookings, service duration and the gap between appointments. For a named person, check `free_per_person`; anyone absent from it can take any time in `free`.",
  "2. AN EMPTY `free` MEANS NOTHING THAT DAY. Say so, offer another day, and in the same message offer to tell them if it frees up ('quer que eu te avise se vagar?') — then call join_waitlist if they accept. Never an hour of your own, never a reason you were not given.",
  "3. WHEN THEY NAME A TIME, CALL book_appointment WITH THAT TIME — not a menu, not a different hour. Do not ask them to confirm a day they already gave: you are told today's date, so 'quarta dia 12' is the next 12th. Ask only when a day is genuinely missing.",
  "4. `your_bookings` IS THE AGENDA OF WHOEVER IS WRITING, filled only when the number they write from belongs to somebody on the team — already checked, so trust it. When it is there, that is what they asked about: read it out, with the customer names. When it is null they are a customer, and you never say who is booked, at what time, or how full anyone's day is.",
  "5. ASKED WHO IS AVAILABLE, NAME ONLY WHO CAN TAKE IT — 'Marcos, Rafa e Duda podem'. Say nothing about the others: not that they are busy, not at what time, not how full their day is.",
].join(" ");

/** De meia em meia hora: é como uma barbearia fala o horário dela. */
const PASSO_MINUTOS = 30;

/**
 * O que dá para marcar — em vez do que está ocupado.
 *
 * Até aqui esta ferramenta devolvia as PEÇAS: o horário da loja, o horário
 * próprio de cada pessoa, as folgas, o que já estava marcado, a duração do
 * serviço e o intervalo entre atendimentos. Descobrir o que sobra era conta do
 * modelo, feita em prosa, seis restrições ao mesmo tempo. Toda falha que
 * sobrou nas medições de 2026/08/10 foi erro nessa conta — nunca erro de dado.
 *
 * A mais clara: pediram 14h com o Jorge, que trabalha 13:00–19:00 naquele dia e
 * não tinha nada marcado. A resposta recusou dizendo que ele "só começa às 13h"
 * e ofereceu, na mesma frase, 14h com ele. O dado estava certo na mão dele.
 *
 * O agendamento nunca errou essa conta, porque ele não a faz em prosa: compõe
 * `trabalhaEm`, `estaDeFolga`, `atende` e `findOverlap`. É por isso que o banco
 * ficou certo em todas as medições enquanto a frase saía errada. Esta função
 * compõe as MESMAS quatro, para que a frase e o banco venham do mesmo cálculo.
 *
 * Sem folgas para o modelo somar, não há soma para ele errar. - 2026/08/10
 */
export function horariosLivres(args: {
  /** O dia, YYYY-MM-DD, no fuso do negócio. */
  date: string;
  abre: string | null;
  fecha: string | null;
  timeZone: string;
  minutes: number;
  config: AppointmentsConfig;
  horarioDaLoja: BusinessHours | undefined;
  equipe: Professional[];
  folgas: Folga[];
  marcados: {
    starts_at: string;
    duration_minutes: number | null;
    professional_id: string | null;
  }[];
  agora: Date;
  servico?: string | null;
}): { livres: string[]; porPessoa: Record<string, string> | null } {
  if (!args.abre || !args.fecha) return { livres: [], porPessoa: null };

  const emMinutos = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);

    return h * 60 + m;
  };

  const abertura = emMinutos(args.abre);
  const fechamento = emMinutos(args.fecha);

  // Quem faz ESTE serviço: oferecer o horário de quem não faz é oferecer o que
  // será recusado depois.
  const podem = args.equipe.filter((pessoa) => atende(pessoa, args.servico));

  const livres: string[] = [];
  const porPessoa = new Map<string, string[]>(
    podem.map((pessoa) => [pessoa.name, []]),
  );

  for (
    let minuto = abertura;
    minuto + args.minutes <= fechamento;
    minuto += PASSO_MINUTOS
  ) {
    const hhmm = `${String(Math.floor(minuto / 60)).padStart(2, "0")}:${
      String(minuto % 60).padStart(2, "0")
    }`;

    const startsAt = localToUtc(`${args.date} ${hhmm}`, args.timeZone);

    // Horário que já passou não é horário livre — e hoje é o dia em que mais
    // se pergunta.
    if (!startsAt || startsAt <= args.agora) continue;

    if (
      args.horarioDaLoja &&
      !fitsOpeningHours(
        args.horarioDaLoja,
        args.timeZone,
        startsAt,
        args.minutes,
      )
    ) {
      continue;
    }

    // Sem ninguém cadastrado a loja é uma agenda só — o salão de uma pessoa,
    // que não tem por que cadastrar a si mesma.
    if (!podem.length) {
      if (estaDeFolga(args.folgas, null, startsAt, args.minutes)) continue;
      if (findOverlap(args.marcados, startsAt, args.minutes, args.config)) {
        continue;
      }

      livres.push(hhmm);
      continue;
    }

    const quem = podem.filter((pessoa) =>
      trabalhaEm(
        pessoa,
        args.horarioDaLoja,
        args.timeZone,
        startsAt,
        args.minutes,
      ) &&
      !estaDeFolga(args.folgas, pessoa.id, startsAt, args.minutes) &&
      !findOverlap(
        args.marcados.filter((m) => m.professional_id === pessoa.id),
        startsAt,
        args.minutes,
        args.config,
      )
    );

    if (!quem.length) continue;

    livres.push(hhmm);

    for (const pessoa of quem) porPessoa.get(pessoa.name)?.push(hhmm);
  }

  /**
   * Só quem foge da lista geral.
   *
   * Quem pega todos os horários livres da casa não acrescenta nada, e repetir a
   * mesma lista em quatro nomes enche o contexto com a mesma informação quatro
   * vezes — foi por isso que `days` já só aparece para quem tem horário
   * próprio. O que interessa é a EXCEÇÃO: o que entra às 13h, o que está de
   * folga à tarde.
   */
  const excecoes = [...porPessoa.entries()]
    .filter(([, horas]) => horas.length !== livres.length)
    .map(([nome, horas]) => [nome, horas.join(" ") || "none"] as const);

  return {
    livres,
    porPessoa: podem.length > 1 && excecoes.length
      ? Object.fromEntries(excecoes)
      : null,
  };
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

  /**
   * A recusa dizia "ofereça outro horário", e ele oferecia — inventado.
   *
   * Medido em 2026/08/10, num feriado: `open` era false, `free` estava vazio,
   * esta ferramenta recusou com "Nobody who takes that service works at that
   * time. Offer another time." — e a frase seguinte ao cliente foi "que tal
   * 14h, 15h ou 16h na mesma quinta?". Três horários num dia em que ninguém
   * abre a porta.
   *
   * A recusa é lida como ordem, e era uma ordem sem limite. Agora ela diz de
   * ONDE o próximo horário sai. O texto de cada motivo perdeu o "offer another
   * time" solto: duas instruções sobre a mesma coisa é uma a mais para
   * escolher. - 2026/08/10
   */
  const ONDE_BUSCAR =
    "Whatever you offer next MUST come from `free` in list_appointments for that day — call it again if you need to. An empty `free` means that day has none at all: offer ANOTHER DAY and, in the same message, offer to let them know if that day frees up — join_waitlist is what puts them on the list. Never an hour of your own.";

  const refuse = (reason: string) => ({
    booked: false,
    professional: null,
    starts_at: null,
    weekday: null,
    reminder_at: null,
    price: null,
    refused: `${reason} (today is ${today}) ${ONDE_BUSCAR}`,
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

    const pedidos = equipe.filter((pessoa) =>
      !pedido || pessoa.name.trim().toLowerCase().includes(pedido)
    );

    const fazem = pedidos.filter((pessoa) => atende(pessoa, input.service));

    const folgas = await folgasDe(
      supabaseClient,
      context.organization.id,
      startsAt,
      minutes,
    );

    const candidatos = fazem
      .filter((pessoa) =>
        trabalhaEm(pessoa, hours ?? undefined, timeZone, startsAt, minutes)
      )
      .filter((pessoa) => !estaDeFolga(folgas, pessoa.id, startsAt, minutes));

    if (pedido && !pedidos.length) {
      return refuse(
        `Nobody called "${input.professional}" works here. Who does: ${
          equipe.map((pessoa) => pessoa.name).join(", ")
        }.`,
      );
    }

    if (pedido && !fazem.length) {
      return refuse(
        `${input.professional} does not take "${input.service}" here.`,
      );
    }

    // Recusa por HORÁRIO da pessoa, e não por agenda cheia: o cliente precisa
    // saber que é o dia dela, senão insiste no mesmo pedido meia hora depois.
    //
    // O MOTIVO da folga não sai daqui. "Não está disponível" é o que o cliente
    // precisa saber; que é dentista, funeral ou férias é assunto da loja, e
    // contar seria o mesmo erro de abrir a agenda de quem está ocupado.
    if (pedido && !candidatos.length) {
      return refuse(
        `${input.professional} is not available at that time. Another person may be — and do not speculate about why.`,
      );
    }

    if (!fazem.length) {
      return refuse(
        `Nobody here takes "${input.service}". Ask the customer to pick another service.`,
      );
    }

    if (!candidatos.length) {
      return refuse(
        `Nobody who takes that service works at that time.`,
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
        }.`,
      );
    }

    profissional = escolhido;
  } else {
    /**
     * Loja de uma pessoa: a folga vale para ela do mesmo jeito.
     *
     * Aqui não há profissional cadastrado, então só as folgas da CASA — as de
     * `professional_id` nulo — podem existir, e são justamente o feriado e o
     * fechamento. Sem esta checagem, o negócio de uma pessoa seria o único que
     * não consegue tirar folga, que é o contrário do razoável: quem trabalha
     * sozinho é quem mais precisa avisar que não estará lá. - 2026/08/09
     */
    const folgas = await folgasDe(
      supabaseClient,
      context.organization.id,
      startsAt,
      minutes,
    );

    if (estaDeFolga(folgas, null, startsAt, minutes)) {
      return refuse(
        "The business is not available at that time, and do not speculate about why.",
      );
    }

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
        }.`,
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
    data.id as string,
  );

  /**
   * Quem estava esperando e acabou de marcar sai da fila.
   *
   * Sem isto o convite aceito continuaria "aguardando resposta", e o relógio
   * dos convites o daria por vencido — oferecendo a MESMA cadeira à próxima
   * pessoa, já ocupada por quem disse sim. Dois clientes, uma cadeira, e a
   * culpa parecendo do balcão.
   *
   * Qualquer pedido em aberto deste contato, e não só o que casa com o horário:
   * quem esperava encaixe e conseguiu marcar não quer continuar na fila.
   */
  await supabaseClient
    .from("waitlist")
    .update({ status: "taken" })
    .eq("organization_id", context.organization.id)
    .eq("contact_address", context.conversation.contact_address ?? "")
    .in("status", ["waiting", "offered"]);

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
  // "Do not ask them to confirm what they already said" entrou em 2026/08/10:
  // um cliente escreveu "marca manicure na próxima quarta, dia 12, às 13h. sou
  // a Rita" — serviço, dia, número do dia, hora e nome — e ouviu de volta "só
  // para confirmar: você quer marcar na quarta, dia 12, às 13h?". Nada foi
  // marcado, e a mensagem seguinte dela, "preciso cancelar", caiu no vazio
  // porque não havia o que cancelar.
  //
  // O modelo estava desambiguando "próxima quarta", que de fato é ambíguo em
  // português — só que o "dia 12" já tinha resolvido. E a conta pende para o
  // outro lado: perguntar custa uma volta em TODA conversa, e marcar errado
  // custa um cancelamento nas poucas em que erra. Desmarcar é barato aqui, e
  // por isso a dúvida se resolve marcando.
  description:
    "Book an appointment for the person you are talking to — the customer comes from this conversation, so there is nobody else to book for and no number to pass. Check `list_appointments` first. DO NOT ASK THEM TO CONFIRM WHAT THEY ALREADY SAID: with the service, the day and the time all there, book it — the confirmation IS your reply. A day number settles a vague weekday ('próxima quarta, dia 12' is the 12th). Booking is undoable and cancelling costs nothing, so resolve doubt by booking, not by asking; ask only when something is genuinely missing. If it comes back refused, tell them the reason and offer another time — never claim it is booked when it is not. ALWAYS REPLY IN THE LANGUAGE THEY ARE USING.",
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
    .select("id, professional_id");

  if (!data?.length) {
    return {
      cancelled: false,
      refused: "No appointment of yours was found at that time.",
    };
  }

  await cancelarLembretes(supabaseClient, data.map((a) => a.id as string));

  /**
   * A cadeira que acabou de vagar é oferecida a quem estava esperando.
   *
   * Aqui e não numa varredura periódica: o encaixe tem prazo curto — quem
   * cancela às 14h para as 15h deixa uma hora, e um cron de dez minutos gasta
   * um sexto dela antes de abrir a boca. E é aqui que se sabe QUAL horário
   * vagou, sem ter de descobrir comparando dois retratos da agenda.
   */
  await convidarDaFila(supabaseClient, context.organization.id, {
    startsAt,
    professionalId: (data[0].professional_id as string | null) ?? null,
    timeZone,
  });

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
    "The new start, same format. The appointment keeps its title and duration. To change only who attends, send the same time here.",
  ),
  professional: z.string().optional().describe(
    "Who should take it from now on, by name — use this when the customer asks to switch person ('prefiro com o Marcos'). Leave it out to keep whoever has it.",
  ),
});

const RescheduleOutputSchema = z.object({
  rescheduled: z.boolean(),
  professional: z.string().nullable().describe(
    "Who has it now. Say this name when you confirm the change.",
  ),
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

  // A mesma regra do agendamento: a recusa diz de onde sai o próximo horário,
  // porque ela é lida como ordem. Ver o comentário em `bookImplementation`.
  const ONDE_BUSCAR =
    "Whatever you offer next MUST come from `free` in list_appointments for that day — call it again if you need to. An empty `free` means that day has none at all: offer ANOTHER DAY and, in the same message, offer to let them know if that day frees up — join_waitlist is what puts them on the list. Never an hour of your own.";

  const refuse = (reason: string) => ({
    rescheduled: false,
    professional: null,
    starts_at: null,
    weekday: null,
    refused: `${reason} (today is ${today}) ${ONDE_BUSCAR}`,
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
    .select("id, duration_minutes, professional_id, title")
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

  /**
   * Remarcar também é trocar de pessoa.
   *
   * Sem isto, "prefiro com o Marcos" só tinha um caminho: cancelar e marcar de
   * novo. Entre uma coisa e outra o horário fica livre para qualquer outro
   * cliente — e o compromisso perde o histórico, virando outro. Trocar aqui
   * mantém a linha e a hora.
   *
   * Continua valendo tudo o que vale ao marcar: a pessoa tem de fazer aquele
   * serviço, trabalhar naquela hora, e estar livre. - 2026/08/09
   */
  const equipe = await activeProfessionals(
    supabaseClient,
    context.organization.id,
  );

  let novoDono: Professional | null = null;

  if (input.professional && equipe.length) {
    const pedido = input.professional.trim().toLowerCase();

    novoDono = equipe.find((pessoa) =>
      pessoa.name.trim().toLowerCase().includes(pedido)
    ) ?? null;

    if (!novoDono) {
      return refuse(
        `Nobody called "${input.professional}" works here. Who does: ${
          equipe.map((pessoa) => pessoa.name).join(", ")
        }.`,
      );
    }

    if (
      !trabalhaEm(novoDono, hours ?? undefined, timeZone, to, minutes)
    ) {
      return refuse(
        `${novoDono.name} does not work at that time. Another person may be free then.`,
      );
    }
  }

  /**
   * A folga vale ao remarcar também.
   *
   * Sem isto sobra uma porta dos fundos: marca-se num horário livre e move-se
   * para dentro da folga, que é justamente o que um cliente insistente tenta
   * quando ouve não. Vale para quem vai FICAR com o compromisso — trocar de
   * barbeiro para um que está de folga é o mesmo furo.
   */
  const folgas = await folgasDe(
    supabaseClient,
    context.organization.id,
    to,
    minutes,
  );

  const donoDepois = novoDono?.id ??
    (appointment.professional_id as string | null);

  if (estaDeFolga(folgas, donoDepois, to, minutes)) {
    return refuse(
      "That time is not available, and do not speculate about why.",
    );
  }

  /**
   * O conflito é da pessoa que vai FICAR com o compromisso.
   *
   * Trocando de dono, o horário livre é o dele — não o de quem tinha antes. E
   * o próprio compromisso continua não contando contra si mesmo, senão
   * trocar de barbeiro mantendo a hora se recusaria sozinho.
   */
  const donoFinal = novoDono?.id ??
    (appointment.professional_id as string | null);

  const marcados = equipe.length
    ? (await agendaOcupada(supabaseClient, context.organization.id, to, minutes))
      .filter((m) => m.professional_id === donoFinal)
    : null;

  const conflict = marcados
    ? findOverlap(marcados, to, minutes, config)
    : await findConflict(
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
      }.`,
    );
  }

  await supabaseClient
    .from("appointments")
    .update({
      starts_at: to.toISOString(),
      ...(novoDono ? { professional_id: novoDono.id } : {}),
    })
    .eq("id", appointment.id as string);

  /**
   * O lembrete acompanha a remarcação: fora o velho, dentro o novo.
   *
   * Sem isto o cliente que passou de quarta para sexta recebia, na terça, o
   * lembrete de quarta — e não recebia nenhum de sexta. Pior que não lembrar:
   * lembra da hora errada, e ele aparece no dia em que a cadeira está ocupada.
   */
  await cancelarLembretes(supabaseClient, [appointment.id as string]);

  await scheduleReminder(
    context,
    supabaseClient,
    to,
    timeZone,
    appointment.id as string,
  );

  // Remarcar também libera uma cadeira — a do horário ANTIGO. Some do dono
  // anterior, e ninguém saberia se este ponto não avisasse.
  await convidarDaFila(supabaseClient, context.organization.id, {
    startsAt: from,
    professionalId: (appointment.professional_id as string | null) ?? null,
    timeZone,
  });

  return {
    rescheduled: true,
    professional: novoDono?.name ??
      equipe.find((pessoa) =>
        pessoa.id === (appointment.professional_id as string | null)
      )?.name ?? null,
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
    // Marcar de novo deixaria a pessoa com dois compromissos; cancelar antes
    // libera a cadeira para outro enquanto você digita.
    "Move an existing appointment of the person you are talking to — new day, new time, or a different colleague. USE THIS, never a second booking, when they change their mind about something they already have. To switch only who attends, send the same time and the new name. ALWAYS REPLY IN THE LANGUAGE THEY ARE USING.",
  inputSchema: z.toJSONSchema(RescheduleInputSchema),
  outputSchema: z.toJSONSchema(RescheduleOutputSchema),
  implementation: rescheduleImplementation,
};
