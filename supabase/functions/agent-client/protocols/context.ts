import type { BusinessHours } from "../../_shared/types/extra_types.ts";
import type { RequestContext } from "./base.ts";

/**
 * The runtime facts handed to the model on every turn, above the agent's own
 * instructions.
 *
 * Both protocols built this inline and identically, which is the arrangement
 * where a fix lands in one and not the other — and the fix here is exactly the
 * kind that would go unnoticed, since a wrong clock produces confident wrong
 * answers rather than errors. - 2026/08/01
 */

/**
 * Used when the organization has not set one. Brasília: this product's
 * customers are Brazilian, and a default that is wrong for everyone (UTC) is
 * worse than one that is right for most.
 */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Sunday first, matching `BusinessHours` and `Intl`'s own weekday order. */
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * Wall-clock reading of `date` in `timeZone`, as parts we can compare.
 *
 * `Intl` rather than a dayjs plugin: Deno ships full ICU, so the zone database
 * is already there, and this needs no dependency that could go unmaintained
 * the way the timezone plugins have a habit of doing.
 */
function wallClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  // "24" appears at midnight in some ICU versions under hour12: false.
  const hour = get("hour") === "24" ? "00" : get("hour");

  return {
    weekday: get("weekday"),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
    dayIndex: WEEKDAYS.indexOf(
      get("weekday").toLowerCase() as (typeof WEEKDAYS)[number],
    ),
  };
}

/**
 * Os próximos dias em que a casa abre — data, nome do dia e horário.
 *
 * Calculado aqui e entregue pronto, em vez de deixar o modelo derivar a partir
 * da semana e do dia de hoje. Ver o comentário no ponto de uso: derivar deu
 * "quarta (10/08)" para uma segunda-feira fechada. Quatro dias bastam para
 * cobrir a resposta "quando vocês abrem" sem inchar o contexto. - 2026/08/08
 */
/** Amanhã: data, nome do dia e se a casa abre. Ver o ponto de uso. */
function tomorrowIn(hours: BusinessHours, timeZone: string) {
  const quando = new Date(Date.now() + 24 * 60 * 60 * 1000);
  quando.setUTCHours(12, 0, 0, 0);

  const { weekday, date, dayIndex } = wallClock(quando, timeZone);
  const faixa = hours[dayIndex];

  return {
    date,
    weekday,
    open: !!faixa,
    ...(faixa ? { opens_at: faixa.from, closes_at: faixa.to } : {}),
  };
}

function nextOpenDays(hours: BusinessHours, timeZone: string) {
  const dias = [];

  for (let adiante = 1; adiante <= 14 && dias.length < 4; adiante++) {
    // Meio-dia, e não meia-noite: a virada de fuso na madrugada trocaria o dia.
    const quando = new Date(Date.now() + adiante * 24 * 60 * 60 * 1000);
    quando.setUTCHours(12, 0, 0, 0);

    const { weekday, date, dayIndex } = wallClock(quando, timeZone);
    const faixa = hours[dayIndex];

    if (!faixa) continue;

    dias.push({ date, weekday, opens_at: faixa.from, closes_at: faixa.to });
  }

  return dias;
}

/**
 * Whether the business is open at `date`.
 *
 * Computed here rather than left to the model. Comparing "17:45" against a
 * seven-row table is arithmetic, and a model asked to do arithmetic in prose
 * will sometimes get it wrong — confidently, and only for the customer who
 * wrote at closing time.
 */
export function isOpenAt(
  hours: BusinessHours,
  timeZone: string,
  date = new Date(),
): boolean {
  const { time, dayIndex } = wallClock(date, timeZone);

  if (dayIndex < 0) return false;

  const today = hours[dayIndex];

  if (today) {
    // A day that ends earlier than it starts runs past midnight.
    const overnight = today.to <= today.from;

    if (
      overnight ? time >= today.from : time >= today.from && time < today.to
    ) {
      return true;
    }
  }

  // Yesterday's overnight range can still be running: at 01:00 on Sunday a bar
  // that opened 18:00 Saturday is open, and today's row says nothing about it.
  const yesterday = hours[(dayIndex + 6) % 7];

  return !!yesterday && yesterday.to <= yesterday.from && time < yesterday.to;
}

/** Human-readable schedule, one line per day, closed days included. */
function describeHours(hours: BusinessHours): Record<string, string> {
  return Object.fromEntries(
    WEEKDAYS.map((day, index) => {
      const range = hours[index];

      return [day, range ? `${range.from}-${range.to}` : "closed"];
    }),
  );
}

/**
 * O que o canal aceita, e como se escreve nele.
 *
 * Metade disto é fato, não gosto: o WhatsApp marca negrito com um asterisco,
 * não dois. Um modelo treinado em markdown escreve `**10:30**`, e o cliente
 * recebe os asteriscos na tela. Título com `#`, tabela com `|`, link em
 * colchetes — nada disso existe ali; chega como sujeira.
 *
 * A outra metade é o que faz parecer gente. Resposta de WhatsApp é curta e
 * corrida; lista com marcadores, negrito em cada horário e emoji de abertura
 * são a assinatura visual de um robô. Um atendente escreveria "tenho 10:30,
 * meio-dia ou 13:30, qual fica melhor?" — numa linha.
 *
 * Fica no contexto e não no prompt de cada organização porque é verdade sobre
 * o meio, igual ao relógio e ao horário de atendimento. Quem quiser outra voz
 * escreve nas instruções do agente, que vêm depois e mandam mais. - 2026/08/02
 */
function channelOf(service: string) {
  // `local` entra junto de propósito: é a conversa de teste do próprio
  // produto, e existe para ensaiar o que vai acontecer no WhatsApp. Um ensaio
  // que segue outras regras é um ensaio que mente — exatamente o defeito que
  // este projeto passou o dia caçando.
  const conversational = ["whatsapp", "whatsapp-web", "local"];

  if (!conversational.includes(service)) return {};

  return {
    channel: {
      name: "WhatsApp",
      formatting:
        "*bold* with ONE asterisk, _italic_, ~strikethrough~, ```code```. Markdown does NOT render here: never write **double asterisks**, # headings, | tables |, or [links](url) — they reach the customer as literal characters.",
      style:
        "Write like a person typing on a phone: short, direct, no bullet lists, at most one emoji and usually none. Offer options inside a sentence instead of as a list. Do not restate what the customer just said before answering it.",
    },
  };
}

export function buildRuntimeContext(context: RequestContext) {
  const timezone = context.organization.extra?.timezone || DEFAULT_TIMEZONE;
  const hours = context.organization.extra?.business_hours;

  const { weekday, date, time } = wallClock(new Date(), timezone);

  // `hours?.length` não bastava: a tela grava a semana como sete `null`
  // enquanto ninguém ligou nenhum dia, e sete nulos têm comprimento sete. O
  // agente recebia "closed" em todos os dias e passava a conversa inteira
  // dizendo ao cliente que a empresa nunca abre — foi o que uma simulação de
  // dez turnos produziu, com o modelo se comportando bem a partir de uma
  // informação errada.
  //
  // Semana sem nenhum dia é "não configurado": melhor o agente não falar de
  // horário do que inventar um fechamento permanente. - 2026/08/02
  const configured = hours?.some((day) => !!day) ? hours : undefined;

  // Só os que têm as duas metades: um link com rótulo e sem URL é uma linha
  // que o modelo lê como promessa e não consegue cumprir.
  const links = context.agent?.extra?.links?.filter(
    (link) => link?.label?.trim() && link?.url?.trim(),
  );

  return {
    now: `${weekday}, ${date} ${time} (${timezone})`,
    ...channelOf(context.conversation.service),
    // Entregues como dado, não como texto no meio das instruções: a URL chega
    // literal, e trocar o preço de um plano não passa por reescrever prompt.
    ...(links?.length
      ? {
        links: links.map((link) => ({
          what: link.label.trim(),
          url: link.url.trim(),
        })),
      }
      : {}),
    /**
     * O catálogo, para ele não inventar serviço.
     *
     * Simulado em 2026/08/07: "faz barba?" recebeu "Sim, fazemos barba" — dito
     * a partir das instruções, que falam de barbearia, e desmentido no passo
     * seguinte pela própria ferramenta ("Não fazemos barba. Temos Corte,
     * Escova, Hidratação..."). O cliente viu as duas.
     *
     * O catálogo estava só dentro da resposta de `list_appointments`, ou seja,
     * só depois de o modelo decidir consultar — e para responder "vocês fazem
     * X?" ele não consulta, porque acha que já sabe. Aqui ele sabe de verdade.
     *
     * `price` vai junto, inclusive quando é nulo: preço ausente é a diferença
     * entre "custa tanto" e "a equipe confirma", e essa distinção não pode
     * depender de o modelo lembrar. - 2026/08/07
     */
    ...(context.organization.extra?.appointments?.services?.length
      ? {
        services: context.organization.extra.appointments.services.map((
          service,
        ) => ({
          name: service.name,
          minutes: service.minutes ?? null,
          price: service.price ?? null,
        })),
      }
      : {}),
    // O que ESTE contato já tem marcado. Sem isto ele pede o dia e a hora a
    // quem ligou justamente porque não lembra.
    ...(context.appointments?.length
      ? { your_appointments: context.appointments }
      : {}),
    ...(configured
      ? {
        business_hours: describeHours(configured),
        // Stated plainly because it is the fact that changes what the agent
        // should say — whether to promise someone will look now, or to say
        // it will be tomorrow.
        open_now: isOpenAt(configured, timezone),
        /**
         * Os próximos dias em que a casa abre, com data e nome do dia.
         *
         * Ele já tinha a semana e o dia de hoje, e precisava derivar o resto —
         * que é conta de calendário, não conversa. Medido em 2026/08/08: à
         * pergunta de um domingo, a assistente respondeu "podemos marcar para
         * quarta (10/08)". 10/08 é segunda, e segunda a casa fecha. Ela errou o
         * nome do dia e ofereceu um dia fechado, que é a promessa que o cliente
         * descobre na porta.
         *
         * A assistente do salão, com a mesma informação e o mesmo modelo,
         * acertou. Ou seja: dá para acertar deduzindo, e às vezes se erra —
         * então o que estava faltando não era instrução, era o fato pronto.
         * - 2026/08/08
         */
        next_open_days: nextOpenDays(configured, timezone),
        /**
         * Amanhã, dito com todas as letras.
         *
         * Com `next_open_days` no contexto, duas de seis respostas passaram a
         * errar QUE DIA é amanhã — "amanhã é terça" e "amanhã é segunda" num
         * sábado. A lista começa no próximo dia aberto, e o modelo lia o
         * primeiro item como se fosse amanhã.
         *
         * A palavra "amanhã" é a mais usada por quem marca horário, e era a
         * única data que continuava sendo conta. Agora não é. - 2026/08/08
         */
        tomorrow: tomorrowIn(configured, timezone),
      }
      : {}),
    /**
     * A saudação automática já saiu; não cumprimente de novo.
     *
     * A boas-vindas deixou de encerrar a conversa hoje e passou a entrar no
     * contexto como mensagem do próprio assistente. A aposta era que ver a
     * saudação já dada bastasse para ele ir direto ao assunto. Medido: não
     * bastou. À pergunta "queria marcar um corte pra sexta de manhã" ele
     * respondeu "¡Hola! ¿En qué puedo ayudarte?" — cumprimentou de novo, e
     * ainda no idioma da mensagem automática.
     *
     * Dito como fato da conversa, e não como regra nas instruções: instrução é
     * do cliente, que a reescreve e apaga. Isto é uma condição, como
     * "está aberto agora". - 2026/08/06
     */
    ...(context.messages?.some((message) => message.direction === "outgoing")
      ? {
        greeting_already_sent: true,
        answer_the_request_directly: true,
      }
      : {}),
    user: {
      name: context.contact?.name,
      phone: context.conversation.contact_address
        ? "+" + context.conversation.contact_address
        : undefined,
      // O que já se sabe desta pessoa, de conversas anteriores. Cinco linhas
      // atravessam meses; a janela de contexto não. Sai quando não há nada,
      // para não ensinar o modelo a inventar o que preencheria o campo.
      about: context.contact?.extra?.summary || undefined,
    },
  };
}
