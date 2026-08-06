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
