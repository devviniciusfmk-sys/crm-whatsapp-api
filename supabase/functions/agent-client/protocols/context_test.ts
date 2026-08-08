import { assertEquals } from "jsr:@std/assert@1";
import { coerceRespondMessages } from "./chat-completions.ts";
import { silenceNote } from "./base.ts";
import { buildRuntimeContext, isOpenAt } from "./context.ts";
import type { BusinessHours } from "../../_shared/types/extra_types.ts";

/**
 * The first test in this repository, and it earns the exception for one
 * reason: `isOpenAt` is arithmetic whose wrong answers look plausible. A
 * conversation at 21:00 that gets told the shop is closed reads as a policy,
 * not as a bug, so nobody reports it.
 *
 * Run with `deno test` from `supabase/functions`.
 */

const TZ = "America/Sao_Paulo"; // UTC-3, no DST since 2019.

/** Sunday first. Weekdays 09:00-18:00, Saturday half day, Sunday closed. */
const office: BusinessHours = [
  null,
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "18:00" },
  { from: "09:00", to: "13:00" },
];

/** Friday and Saturday nights, 18:00 through 02:00 the next morning. */
const bar: BusinessHours = [
  null,
  null,
  null,
  null,
  null,
  { from: "18:00", to: "02:00" },
  { from: "18:00", to: "02:00" },
];

const cases: [string, BusinessHours, string, boolean][] = [
  ["Tuesday 10:00", office, "2026-08-04T13:00:00Z", true],
  ["a minute before opening", office, "2026-08-04T11:59:00Z", false],
  ["on the closing minute", office, "2026-08-04T21:00:00Z", false],
  ["a minute before closing", office, "2026-08-04T20:59:00Z", true],
  ["Sunday, no row at all", office, "2026-08-02T13:00:00Z", false],
  ["Saturday within the half day", office, "2026-08-01T15:00:00Z", true],
  ["Saturday after the half day", office, "2026-08-01T17:00:00Z", false],
  // The reason the timezone exists: 21:00 in São Paulo is already midnight of
  // the following day in UTC, so a UTC clock reads Wednesday and the whole
  // schedule shifts by a day.
  [
    "21:00 local, already tomorrow in UTC",
    office,
    "2026-08-05T00:00:00Z",
    false,
  ],
  ["open on Friday night", bar, "2026-08-08T02:00:00Z", true],
  ["still open after midnight", bar, "2026-08-08T04:00:00Z", true],
  ["closed once the overnight range ends", bar, "2026-08-08T06:00:00Z", false],
  // Sunday has no row of its own; being open depends on Saturday's range.
  ["Sunday 01:00 belongs to Saturday", bar, "2026-08-09T04:00:00Z", true],
  ["Sunday 03:00 belongs to nobody", bar, "2026-08-09T06:00:00Z", false],
];

for (const [name, hours, instant, expected] of cases) {
  Deno.test(`isOpenAt: ${name}`, () => {
    assertEquals(isOpenAt(hours, TZ, new Date(instant)), expected);
  });
}

Deno.test("semana sem nenhum dia não vira 'fechado todos os dias'", () => {
  // Sete `null` é como a tela grava enquanto ninguém ligou um dia sequer.
  // Descrever isso como fechado fez o agente passar dez turnos dizendo ao
  // cliente que a empresa nunca abre. - 2026/08/02
  const context = {
    organization: {
      extra: {
        timezone: "America/Sao_Paulo",
        business_hours: [null, null, null, null, null, null, null],
      },
    },
    conversation: { contact_address: "5511999999999" },
    contact: undefined,
  } as unknown as Parameters<typeof buildRuntimeContext>[0];

  const runtime = buildRuntimeContext(context);

  assertEquals("business_hours" in runtime, false);
  assertEquals("open_now" in runtime, false);
});

Deno.test("semana com um dia configurado continua sendo descrita", () => {
  const hours = [
    null,
    { from: "09:00", to: "18:00" },
    null,
    null,
    null,
    null,
    null,
  ];

  const context = {
    organization: {
      extra: { timezone: "America/Sao_Paulo", business_hours: hours },
    },
    conversation: { contact_address: "5511999999999" },
    contact: undefined,
  } as unknown as Parameters<typeof buildRuntimeContext>[0];

  const runtime = buildRuntimeContext(context) as {
    business_hours?: Record<string, string>;
  };

  assertEquals(runtime.business_hours?.monday, "09:00-18:00");
  assertEquals(runtime.business_hours?.sunday, "closed");
});

Deno.test("canais de conversa recebem as regras; e-mail e afins não", () => {
  const make = (service: string) =>
    buildRuntimeContext(
      {
        organization: { extra: { timezone: "America/Sao_Paulo" } },
        conversation: { contact_address: "5511999999999", service },
        contact: undefined,
      } as unknown as Parameters<typeof buildRuntimeContext>[0],
    ) as {
      channel?: { formatting: string };
    };

  // Um asterisco é o negrito do WhatsApp; dois chegam como caractere.
  assertEquals(
    make("whatsapp").channel?.formatting.includes("ONE asterisk"),
    true,
  );
  assertEquals(make("whatsapp-web").channel !== undefined, true);
  // A conversa de teste segue as mesmas regras: um ensaio com outras regras
  // é um ensaio que mente.
  assertEquals(make("local").channel !== undefined, true);
  assertEquals(make("email").channel, undefined);
});

Deno.test("a memória do cliente entra no contexto, e some quando está vazia", () => {
  const make = (summary?: string) =>
    buildRuntimeContext(
      {
        organization: { extra: { timezone: "America/Sao_Paulo" } },
        conversation: { contact_address: "5511999999999", service: "whatsapp" },
        contact: { name: "Maria", extra: summary ? { summary } : {} },
      } as unknown as Parameters<typeof buildRuntimeContext>[0],
    ) as { user?: { about?: string } };

  assertEquals(
    make("Faz limpeza de pele a cada 45 dias. Alérgica a ácido salicílico.")
      .user?.about,
    "Faz limpeza de pele a cada 45 dias. Alérgica a ácido salicílico.",
  );

  // Ausente, e não presente-e-vazio: um campo `about: ""` no contexto convida o
  // modelo a preencher o que falta, e ficha inventada é pior que ficha vazia.
  assertEquals(make(undefined).user?.about, undefined);
  assertEquals(make("").user?.about, undefined);
});

Deno.test("os links do agente entram no contexto; incompletos ficam de fora", () => {
  const make = (links?: unknown) =>
    buildRuntimeContext(
      {
        organization: { extra: { timezone: "America/Sao_Paulo" } },
        conversation: { contact_address: "5511999999999", service: "whatsapp" },
        contact: undefined,
        agent: { extra: { links } },
      } as unknown as Parameters<typeof buildRuntimeContext>[0],
    ) as { links?: { what: string; url: string }[] };

  const runtime = make([
    {
      label: " Checkout Premium — R$ 29,90 ",
      url: " https://pay.exemplo/premium ",
    },
    { label: "Sem endereço", url: "" },
    { label: "", url: "https://pay.exemplo/orfao" },
  ]);

  // Aparado, e só o que está inteiro: rótulo sem URL é promessa que o modelo
  // não consegue cumprir, e URL sem rótulo ele não sabe quando mandar.
  assertEquals(runtime.links?.length, 1);
  assertEquals(runtime.links?.[0].what, "Checkout Premium — R$ 29,90");
  assertEquals(runtime.links?.[0].url, "https://pay.exemplo/premium");

  // Sem links configurados, a chave não existe — campo vazio no contexto é
  // convite para o modelo inventar uma URL.
  assertEquals(make(undefined).links, undefined);
  assertEquals(make([]).links, undefined);
});

Deno.test("respond: as formas que o modelo manda viram mensagem", () => {
  // O leitor antigo só aceitava a forma do esquema; tudo o mais virava
  // "silêncio", e o cliente ficava sem resposta. Cada caso aqui é uma forma
  // vista ou plausível vinda do modelo. - 2026/08/05
  assertEquals(coerceRespondMessages("Bom dia"), [
    { type: "text", text: "Bom dia" },
  ]);

  assertEquals(coerceRespondMessages(["Oi", "tudo bem?"]), [
    { type: "text", text: "Oi" },
    { type: "text", text: "tudo bem?" },
  ]);

  assertEquals(coerceRespondMessages({ type: "text", text: "Olá" }), [
    { type: "text", text: "Olá" },
  ]);

  assertEquals(coerceRespondMessages([{ content: "Olá" }]), [
    { type: "text", text: "Olá" },
  ]);

  assertEquals(coerceRespondMessages([{ message: "Olá" }]), [
    { type: "text", text: "Olá" },
  ]);

  // A forma do esquema continua passando intacta.
  assertEquals(
    coerceRespondMessages([{ type: "text", text: "certo" }]),
    [{ type: "text", text: "certo" }],
  );

  // Arquivo mantém a URI, que é o que o resto do código usa para buscá-lo.
  assertEquals(
    coerceRespondMessages([{
      type: "file",
      uri: "internal://x",
      name: "a.pdf",
    }]),
    [{ type: "file", uri: "internal://x", name: "a.pdf", text: undefined }],
  );

  // Sem texto nenhum continua sendo silêncio: tolerar forma não é inventar
  // conteúdo.
  assertEquals(coerceRespondMessages([]), []);
  assertEquals(coerceRespondMessages(undefined), []);
  assertEquals(coerceRespondMessages([{ type: "text", text: "  " }]), []);
  assertEquals(coerceRespondMessages([{ algo: 1 }]), []);
});

Deno.test("a nota de silêncio carrega os números da chamada", () => {
  const usage = {
    messages: 12,
    tools: 7,
    prompt: 3410,
    completion: 64,
    reasoning: 51,
  };

  const nota = silenceNote("o modelo estourou o limite", usage);

  // O motivo continua legível na frente, e os cinco números atrás dele: é a
  // diferença entre "aconteceu" e "aconteceu por isto". Foram três iterações
  // para chegar aqui — silêncio sem rastro, rastro sem motivo, motivo sem
  // número — e cada uma custou um contato sem resposta. - 2026/08/06
  assertEquals(
    nota,
    "o modelo estourou o limite (12 mensagens, 7 ferramentas, 3410 tokens de entrada, 51 de raciocínio, 64 de saída)",
  );

  // Sem números, o motivo sozinho — e nunca um parêntese vazio pendurado.
  assertEquals(silenceNote("sem uso"), "sem uso");
});

Deno.test("depois da saudação automática, o contexto manda responder direto", () => {
  const make = (direcoes: string[]) =>
    buildRuntimeContext(
      {
        organization: { extra: { timezone: "America/Sao_Paulo" } },
        conversation: { contact_address: "5511999999999", service: "whatsapp" },
        messages: direcoes.map((direction) => ({ direction })),
      } as unknown as Parameters<typeof buildRuntimeContext>[0],
    ) as { greeting_already_sent?: boolean };

  // A boas-vindas entra no histórico como mensagem de saída. Sem este aviso o
  // modelo cumprimentou de novo em vez de responder o pedido — medido, não
  // suposto: "queria marcar um corte pra sexta" recebeu "¡Hola! ¿En qué puedo
  // ayudarte?". - 2026/08/06
  assertEquals(make(["incoming", "outgoing"]).greeting_already_sent, true);

  // Conversa que ainda não teve resposta nenhuma não recebe o campo: dizer
  // "já cumprimentou" quando ninguém cumprimentou faria o assistente pular a
  // saudação que a pessoa espera.
  assertEquals(make(["incoming"]).greeting_already_sent, undefined);
  assertEquals(make([]).greeting_already_sent, undefined);
});

Deno.test("o catálogo e os compromissos do contato entram no contexto", () => {
  const contexto = buildRuntimeContext(
    {
      organization: {
        extra: {
          timezone: "America/Sao_Paulo",
          appointments: {
            services: [
              { name: "Corte", minutes: 60 },
              { name: "Coloração", minutes: 180, price: 250 },
            ],
          },
        },
      },
      conversation: { contact_address: "5511999999999", service: "whatsapp" },
      appointments: [
        {
          title: "Corte",
          starts_at: "2026-08-08 15:15",
          weekday: "saturday",
          duration_minutes: 60,
        },
      ],
    } as unknown as Parameters<typeof buildRuntimeContext>[0],
  ) as {
    services?: Array<{ name: string; price: number | null }>;
    your_appointments?: Array<{ starts_at: string }>;
  };

  // Sem o catálogo aqui, "faz barba?" era respondido pelas instruções — e a
  // ferramenta desmentia no passo seguinte, na frente do cliente. - 2026/08/07
  assertEquals(contexto.services?.map((s) => s.name), ["Corte", "Coloração"]);

  // Preço nulo é informação, não ausência de informação: é a diferença entre
  // "custa 250" e "a equipe confirma".
  assertEquals(contexto.services?.[0].price, null);
  assertEquals(contexto.services?.[1].price, 250);

  // O horário do próprio cliente, para ele não precisar lembrar a data quando
  // pede para cancelar.
  assertEquals(contexto.your_appointments?.[0].starts_at, "2026-08-08 15:15");
});

Deno.test("sem catálogo e sem compromissos, os campos não aparecem", () => {
  const contexto = buildRuntimeContext(
    {
      organization: { extra: { timezone: "America/Sao_Paulo" } },
      conversation: { contact_address: "5511999999999", service: "whatsapp" },
    } as unknown as Parameters<typeof buildRuntimeContext>[0],
  ) as { services?: unknown; your_appointments?: unknown };

  // Campo vazio ensina o modelo a preencher: catálogo vazio viraria serviço
  // inventado, e lista de compromissos vazia viraria compromisso inventado.
  assertEquals(contexto.services, undefined);
  assertEquals(contexto.your_appointments, undefined);
});

Deno.test("respond: arquivo que não é arquivo vira texto", () => {
  // O que chegou de verdade em produção: a resposta inteira embrulhada numa
  // URI de esquema inventado. A busca no armazenamento não achava nada e a
  // resposta morria — uma em cada três conversas. - 2026/08/07
  assertEquals(
    coerceRespondMessages([{
      type: "file",
      uri: "text://Oi, tudo bem? Como posso ajudar?",
    }]),
    [{ type: "text", text: "Oi, tudo bem? Como posso ajudar?" }],
  );

  // Com legenda, a legenda ganha: é o que o modelo escreveu para a pessoa ler.
  assertEquals(
    coerceRespondMessages([{
      type: "file",
      uri: "https://exemplo.com/cardapio.pdf",
      text: "Segue o cardápio",
    }]),
    [{ type: "text", text: "Segue o cardápio" }],
  );

  // `internal://` continua sendo arquivo de verdade, que é o único que este
  // sistema serve.
  assertEquals(
    coerceRespondMessages([{ type: "file", uri: "internal://media/x.pdf" }]),
    [{
      type: "file",
      uri: "internal://media/x.pdf",
      name: undefined,
      text: undefined,
    }],
  );

  // Sem nada legível, silêncio continua sendo silêncio.
  assertEquals(
    coerceRespondMessages([{ type: "file", uri: "text://   " }]),
    [],
  );
});

Deno.test("os próximos dias abertos vêm prontos, e nenhum é dia fechado", () => {
  const contexto = buildRuntimeContext(
    {
      organization: {
        extra: {
          timezone: "America/Sao_Paulo",
          // Terça a sábado: domingo e segunda fechados, como as duas casas.
          business_hours: [
            null,
            null,
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "17:00" },
          ],
        },
      },
      conversation: { contact_address: "5511999999999", service: "whatsapp" },
    } as unknown as Parameters<typeof buildRuntimeContext>[0],
  ) as {
    next_open_days?: Array<{ date: string; weekday: string; opens_at: string }>;
  };

  const dias = contexto.next_open_days ?? [];

  assertEquals(dias.length, 4);

  // Nenhum domingo e nenhuma segunda: era exatamente o erro medido — oferecer
  // "quarta (10/08)" para uma segunda-feira fechada. - 2026/08/08
  assertEquals(
    dias.some((d) => ["sunday", "monday"].includes(d.weekday.toLowerCase())),
    false,
  );

  // E o nome do dia tem de bater com a data, que é a conta que o modelo errou.
  for (const dia of dias) {
    const real = new Date(`${dia.date}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
    });

    assertEquals(dia.weekday.toLowerCase(), real.toLowerCase());
  }
});

Deno.test("amanhã vem pronto: data, nome do dia e se abre", () => {
  const contexto = buildRuntimeContext(
    {
      organization: {
        extra: {
          timezone: "America/Sao_Paulo",
          business_hours: [
            null,
            null,
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "19:00" },
            { from: "09:00", to: "17:00" },
          ],
        },
      },
      conversation: { contact_address: "5511999999999", service: "whatsapp" },
    } as unknown as Parameters<typeof buildRuntimeContext>[0],
  ) as { tomorrow?: { date: string; weekday: string; open: boolean } };

  const amanha = contexto.tomorrow!;

  // A data é mesmo a de amanhã no fuso da casa, e o nome do dia bate com ela:
  // era exatamente essa conta que produzia "amanhã é terça" num sábado.
  // - 2026/08/08
  const esperado = new Date(Date.now() + 24 * 60 * 60 * 1000);

  assertEquals(
    amanha.date,
    esperado.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }),
  );

  assertEquals(
    amanha.weekday.toLowerCase(),
    new Date(`${amanha.date}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
    }).toLowerCase(),
  );

  // E "abre" tem de concordar com a semana configurada.
  const fechados = ["sunday", "monday"];
  assertEquals(amanha.open, !fechados.includes(amanha.weekday.toLowerCase()));
});
