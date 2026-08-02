import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import { DEFAULT_TIMEZONE, isOpenAt } from "../protocols/context.ts";
import type { OrganizationExtra } from "../../_shared/types/extra_types.ts";

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
// Consultar o dia
// ---------------------------------------------------------------------------

const ListInputSchema = z.object({
  date: z.string().describe(
    "The day to look at, as YYYY-MM-DD in the business's own timezone. Use the current date you were given to resolve words like 'tomorrow'.",
  ),
});

const ListOutputSchema = z.object({
  date: z.string(),
  weekday: z.string().describe(
    "Which day of the week that date falls on. Use THIS when you name the day to the customer — do not work it out yourself.",
  ),
  open: z.boolean().describe(
    "False when the business does not open at all on that day. Do not offer times on a closed day.",
  ),
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

async function listImplementation(
  input: z.infer<typeof ListInputSchema>,
  _config: void,
  context: RequestContext,
  supabaseClient: SupabaseClient,
): Promise<z.infer<typeof ListOutputSchema>> {
  const timeZone = timezoneOf(context);

  const from = localToUtc(`${input.date} 00:00`, timeZone);

  if (!from) {
    return { date: input.date, weekday: "", open: false, taken: [] };
  }

  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

  // Meio-dia, e não meia-noite: perguntar "abre neste dia" à meia-noite
  // responderia "não" para toda loja que abre às 9h.
  const noon = new Date(from.getTime() + 12 * 60 * 60 * 1000);

  const hours = businessHoursOf(context);
  const open = hours ? isOpenAt(hours, timeZone, noon) : true;

  const { data } = await supabaseClient
    .from("appointments")
    .select("starts_at, duration_minutes, title")
    .eq("organization_id", context.organization.id)
    .eq("status", "scheduled")
    .gte("starts_at", from.toISOString())
    .lt("starts_at", to.toISOString())
    .order("starts_at", { ascending: true });

  return {
    date: input.date,
    weekday: weekdayOf(noon, timeZone),
    open,
    taken: (data ?? []).map((row) => ({
      starts_at: utcToLocal(new Date(row.starts_at as string), timeZone).slice(
        11,
      ),
      duration_minutes: (row.duration_minutes as number | null) ?? null,
      title: row.title as string,
    })),
  };
}

export const ListAppointmentsTool: ToolDefinition<
  typeof ListInputSchema,
  typeof ListOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "list_appointments",
  description:
    "See what is already booked on a given day, and whether the business opens that day. Call this BEFORE offering times to a customer, so you never offer a slot that is taken or a day that is closed. It returns every booking of the business that day, not only this customer's.",
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
  duration_minutes: z.number().int().positive().optional().describe(
    "How long it takes. Omit if you do not know; do not invent one.",
  ),
  notes: z.string().optional().describe(
    "Anything the staff should know before the customer arrives. Optional.",
  ),
});

const BookOutputSchema = z.object({
  booked: z.boolean(),
  starts_at: z.string().nullable().describe("Local time actually recorded."),
  weekday: z.string().nullable().describe(
    "Which day of the week that is. Use THIS when confirming to the customer — do not work it out yourself.",
  ),
  reminder_at: z.string().nullable().describe(
    "When the customer will be reminded, local time, or null when no reminder was scheduled.",
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

/** Quando a duração não é dita, meia hora é o palpite menos ruim. */
const ASSUMED_MINUTES = 30;

/**
 * Um compromisso já marcado que se sobrepõe a este.
 *
 * Comparar só o instante de início não basta, e a primeira simulação mostrou
 * por quê: uma limpeza de uma hora às 10h e outra às 10h30 passavam as duas,
 * porque os `starts_at` são diferentes. Duas pessoas na mesma cadeira.
 *
 * Duração ausente vira meia hora dos dois lados. É palpite, e é melhor que o
 * contrário — tratar como instante deixaria passar exatamente o caso que este
 * teste pegou. - 2026/08/02
 */
async function findConflict(
  supabaseClient: SupabaseClient,
  organizationId: string,
  startsAt: Date,
  durationMinutes?: number,
): Promise<Date | null> {
  const minutes = durationMinutes ?? ASSUMED_MINUTES;
  const endsAt = new Date(startsAt.getTime() + minutes * 60 * 1000);

  // Uma janela generosa em volta, para não trazer o dia inteiro nem perder um
  // compromisso longo que começou antes.
  const from = new Date(startsAt.getTime() - 12 * 60 * 60 * 1000);
  const to = new Date(endsAt.getTime() + 12 * 60 * 60 * 1000);

  const { data } = await supabaseClient
    .from("appointments")
    .select("starts_at, duration_minutes")
    .eq("organization_id", organizationId)
    .eq("status", "scheduled")
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString());

  for (const row of data ?? []) {
    const otherStart = new Date(row.starts_at as string);
    const otherEnd = new Date(
      otherStart.getTime() +
        ((row.duration_minutes as number | null) ?? ASSUMED_MINUTES) * 60 *
          1000,
    );

    if (startsAt < otherEnd && otherStart < endsAt) return otherStart;
  }

  return null;
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
    starts_at: null,
    weekday: null,
    reminder_at: null,
    refused: `${reason} (today is ${today})`,
  });

  const startsAt = localToUtc(input.starts_at, timeZone);

  if (!startsAt) {
    return refuse("The date could not be read. Use 'YYYY-MM-DD HH:MM'.");
  }

  if (startsAt.getTime() <= Date.now()) {
    return refuse("That time is in the past.");
  }

  const hours = businessHoursOf(context);

  if (hours && !isOpenAt(hours, timeZone, startsAt)) {
    return refuse("The business is closed at that time.");
  }

  if (!context.conversation.contact_address) {
    return refuse("This conversation has no phone number to book for.");
  }

  const conflict = await findConflict(
    supabaseClient,
    context.organization.id,
    startsAt,
    input.duration_minutes,
  );

  if (conflict) {
    return refuse(
      `That time overlaps an appointment already booked at ${
        utcToLocal(conflict, timeZone).slice(11)
      }. Offer another time.`,
    );
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
      duration_minutes: input.duration_minutes ?? null,
      notes: input.notes ?? null,
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
    starts_at: utcToLocal(startsAt, timeZone),
    weekday: weekdayOf(startsAt, timeZone),
    reminder_at: reminderAt ? utcToLocal(reminderAt, timeZone) : null,
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

  const hours = businessHoursOf(context);

  if (hours && !isOpenAt(hours, timeZone, to)) {
    return refuse("The business is closed at the new time.");
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

  const conflict = await findConflict(
    supabaseClient,
    context.organization.id,
    to,
    (appointment.duration_minutes as number | null) ?? undefined,
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
