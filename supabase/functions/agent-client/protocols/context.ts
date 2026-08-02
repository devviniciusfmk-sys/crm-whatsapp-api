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

  return {
    now: `${weekday}, ${date} ${time} (${timezone})`,
    ...(configured
      ? {
        business_hours: describeHours(configured),
        // Stated plainly because it is the fact that changes what the agent
        // should say — whether to promise someone will look now, or to say
        // it will be tomorrow.
        open_now: isOpenAt(configured, timezone),
      }
      : {}),
    user: {
      name: context.contact?.name,
      phone: context.conversation.contact_address
        ? "+" + context.conversation.contact_address
        : undefined,
    },
  };
}
