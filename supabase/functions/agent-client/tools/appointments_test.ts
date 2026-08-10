import { assertEquals } from "jsr:@std/assert";
import {
  findOverlap,
  fitsOpeningHours,
  horariosLivres,
  localToUtc,
  minutesFor,
  priceFor,
  utcToLocal,
} from "./appointments.ts";
import type { BusinessHours } from "../../_shared/types/extra_types.ts";

/**
 * O fuso e a duração são o que este arquivo protege.
 *
 * Um erro de três horas aqui não quebra nada visivelmente: o compromisso é
 * gravado, a tela mostra um horário, e só o cliente que aparece na hora errada
 * descobre. É exatamente o tipo de falha que teste pega e revisão não. Vale
 * igual para a duração: dois clientes na mesma cadeira só aparece no dia.
 */

const SP = "America/Sao_Paulo";

Deno.test("hora local vira o instante certo em UTC", () => {
  // Brasília está em UTC-3 o ano todo desde 2019 (sem horário de verão).
  assertEquals(
    localToUtc("2026-08-05 15:00", SP)?.toISOString(),
    "2026-08-05T18:00:00.000Z",
  );
});

Deno.test("aceita espaço ou T entre data e hora", () => {
  assertEquals(
    localToUtc("2026-08-05T15:00", SP)?.toISOString(),
    localToUtc("2026-08-05 15:00", SP)?.toISOString(),
  );
});

Deno.test("recusa o que não souber ler, em vez de inventar uma data", () => {
  assertEquals(localToUtc("quinta que vem", SP), null);
  assertEquals(localToUtc("05/08/2026 15:00", SP), null);
  assertEquals(localToUtc("2026-08-05", SP), null);
});

Deno.test("ida e volta preserva a hora de parede", () => {
  const utc = localToUtc("2026-12-31 23:30", SP)!;

  assertEquals(utcToLocal(utc, SP), "2026-12-31 23:30");
});

Deno.test("meia-noite não vira 24:00", () => {
  const utc = localToUtc("2026-08-05 00:00", SP)!;

  assertEquals(utcToLocal(utc, SP), "2026-08-05 00:00");
});

Deno.test("fuso com meia hora de deslocamento", () => {
  // Índia é UTC+5:30: um deslocamento não inteiro quebra conversões feitas
  // com aritmética de horas.
  assertEquals(
    localToUtc("2026-08-05 15:00", "Asia/Kolkata")?.toISOString(),
    "2026-08-05T09:30:00.000Z",
  );
});

Deno.test("horário de verão: a segunda passada é o que acerta", () => {
  // Lisboa adianta o relógio em 29/03/2026. Uma hora depois da virada, o
  // deslocamento já é +1, e uma conversão de passada única erraria em 60min.
  assertEquals(
    localToUtc("2026-03-29 12:00", "Europe/Lisbon")?.toISOString(),
    "2026-03-29T11:00:00.000Z",
  );
  assertEquals(
    localToUtc("2026-03-28 12:00", "Europe/Lisbon")?.toISOString(),
    "2026-03-28T12:00:00.000Z",
  );
});

// ---------------------------------------------------------------------------
// Duração
// ---------------------------------------------------------------------------

const CATALOG = {
  services: [
    { name: "Corte", minutes: 30, price: 45 },
    { name: "Coloração", minutes: 120, price: 180 },
    // Sem preço: existe, atende, mas ninguém precificou.
    { name: "Barba", minutes: 20 },
  ],
};

Deno.test("sem catálogo, vale o padrão da organização", () => {
  assertEquals(minutesFor({ title: "corte" }, { default_minutes: 120 }), 120);
});

Deno.test("sem catálogo e sem padrão, meia hora", () => {
  assertEquals(minutesFor({ title: "corte" }, {}), 30);
});

Deno.test("sem catálogo, o modelo ainda pode dizer quanto leva", () => {
  assertEquals(
    minutesFor({ title: "corte", duration_minutes: 45 }, {}),
    45,
  );
});

Deno.test("com catálogo, a duração é a do serviço", () => {
  assertEquals(minutesFor({ service: "Coloração" }, CATALOG), 120);
});

Deno.test("com catálogo, o que o modelo mandar é ignorado", () => {
  // O ponto do catálogo: a organização já disse quanto leva, e um número
  // inventado no meio da conversa não ganha dela.
  assertEquals(
    minutesFor({ service: "Coloração", duration_minutes: 15 }, CATALOG),
    120,
  );
});

Deno.test("nome do serviço sem acento e em outra caixa ainda é o mesmo", () => {
  assertEquals(minutesFor({ service: "coloracao" }, CATALOG), 120);
  assertEquals(minutesFor({ service: "  CORTE " }, CATALOG), 30);
});

Deno.test("o título serve quando o serviço não vem separado", () => {
  assertEquals(minutesFor({ title: "Corte" }, CATALOG), 30);
});

Deno.test("serviço fora do catálogo é recusa, não palpite", () => {
  assertEquals(minutesFor({ service: "manicure" }, CATALOG), null);
});

// ---------------------------------------------------------------------------
// Preço
// ---------------------------------------------------------------------------

Deno.test("o preço sai do catálogo", () => {
  assertEquals(priceFor({ service: "Coloração" }, CATALOG), 180);
  assertEquals(priceFor({ title: "corte" }, CATALOG), 45);
});

Deno.test("serviço sem preço cadastrado fica sem valor, e não em zero", () => {
  // Zero é o atendimento de cortesia; ausente é ninguém ter precificado. Um
  // relatório que somasse os dois diria que a barba não fatura.
  assertEquals(priceFor({ service: "Barba" }, CATALOG), null);
});

Deno.test("sem catálogo não há preço a sugerir", () => {
  assertEquals(priceFor({ title: "Corte" }, { default_minutes: 30 }), null);
});

// ---------------------------------------------------------------------------
// Sobreposição e folga
// ---------------------------------------------------------------------------

/** 10:00 em Brasília, o horário das simulações. */
const at = (local: string) => localToUtc(local, SP)!;

const booked = (local: string, minutes: number | null) => ({
  starts_at: at(local).toISOString(),
  duration_minutes: minutes,
});

Deno.test("uma hora às 10h barra outra às 10h30", () => {
  // O caso que a primeira simulação pegou: `starts_at` diferentes, mesma
  // cadeira.
  assertEquals(
    findOverlap(
      [booked("2026-08-05 10:00", 60)],
      at("2026-08-05 10:30"),
      60,
      {},
    )
      ?.toISOString(),
    at("2026-08-05 10:00").toISOString(),
  );
});

Deno.test("sem folga, colado passa", () => {
  assertEquals(
    findOverlap(
      [booked("2026-08-05 10:00", 60)],
      at("2026-08-05 11:00"),
      60,
      {},
    ),
    null,
  );
});

Deno.test("com 30 de folga, colado não passa mais", () => {
  assertEquals(
    findOverlap(
      [booked("2026-08-05 10:00", 60)],
      at("2026-08-05 11:00"),
      60,
      { buffer_minutes: 30 },
    )?.toISOString(),
    at("2026-08-05 10:00").toISOString(),
  );

  assertEquals(
    findOverlap(
      [booked("2026-08-05 10:00", 60)],
      at("2026-08-05 11:30"),
      60,
      { buffer_minutes: 30 },
    ),
    null,
  );
});

Deno.test("a folga também vale para quem chega antes", () => {
  // Somá-la só depois do que já estava marcado deixaria passar o compromisso
  // novo que termina em cima do começo do seguinte.
  assertEquals(
    findOverlap(
      [booked("2026-08-05 11:00", 60)],
      at("2026-08-05 10:00"),
      60,
      { buffer_minutes: 30 },
    )?.toISOString(),
    at("2026-08-05 11:00").toISOString(),
  );
});

Deno.test("compromisso antigo sem duração usa o padrão da organização", () => {
  // Gravados antes de a duração ser resolvida na hora de marcar.
  assertEquals(
    findOverlap(
      [booked("2026-08-05 10:00", null)],
      at("2026-08-05 11:00"),
      60,
      { default_minutes: 120 },
    )?.toISOString(),
    at("2026-08-05 10:00").toISOString(),
  );
});

// ---------------------------------------------------------------------------
// Horário de atendimento
// ---------------------------------------------------------------------------

const NINE_TO_SIX: BusinessHours = Array.from(
  { length: 7 },
  () => ({ from: "09:00", to: "18:00" }),
);

Deno.test("cabe dentro do horário", () => {
  assertEquals(
    fitsOpeningHours(NINE_TO_SIX, SP, at("2026-08-05 10:00"), 120),
    true,
  );
});

Deno.test("duas horas às 17h50 não cabem antes de fechar", () => {
  // O furo que a duração maior expôs: só o início era conferido, e o cliente
  // ficava na cadeira com a loja fechada.
  assertEquals(
    fitsOpeningHours(NINE_TO_SIX, SP, at("2026-08-05 17:50"), 120),
    false,
  );
});

Deno.test("terminar às 18:00 em ponto ainda é dentro", () => {
  assertEquals(
    fitsOpeningHours(NINE_TO_SIX, SP, at("2026-08-05 16:00"), 120),
    true,
  );
});

Deno.test("antes de abrir continua fora", () => {
  assertEquals(
    fitsOpeningHours(NINE_TO_SIX, SP, at("2026-08-05 08:00"), 30),
    false,
  );
});

/**
 * A conta que o modelo errava.
 *
 * Ele recebia as peças — horário da loja, horário próprio de cada pessoa,
 * folgas, o que estava marcado, duração e intervalo — e subtraía em prosa.
 * Errava. Estes testes fixam a mesma conta em código, onde ela custa
 * milissegundos e não erra duas vezes o mesmo jeito. - 2026/08/10
 */

const QUARTA = "2026-08-12";
const ONTEM = new Date("2020-01-01T00:00:00Z");

const SEMPRE_ABERTA: BusinessHours = Array.from(
  { length: 7 },
  () => ({ from: "09:00", to: "19:00" }),
) as BusinessHours;

const base = {
  date: QUARTA,
  abre: "09:00",
  fecha: "19:00",
  timeZone: SP,
  minutes: 30,
  config: { buffer_minutes: 0, default_minutes: 30 },
  horarioDaLoja: SEMPRE_ABERTA,
  equipe: [],
  folgas: [],
  marcados: [],
  agora: ONTEM,
};

// Quem tem horário próprio: 13:00-19:00 na quarta, o resto fechado.
const JORGE = {
  id: "jorge",
  name: "Jorge",
  extra: {
    business_hours: [
      null,
      null,
      null,
      { from: "13:00", to: "19:00" },
      null,
      null,
      null,
    ],
  },
} as never;

const MARCOS = { id: "marcos", name: "Marcos", extra: {} } as never;

Deno.test("sem ninguém cadastrado, a loja é uma agenda só", () => {
  const { livres } = horariosLivres(base);

  assertEquals(livres[0], "09:00");
  assertEquals(livres.at(-1), "18:30");
  assertEquals(livres.length, 20);
});

Deno.test("compromisso marcado tira só o horário dele", () => {
  const { livres } = horariosLivres({
    ...base,
    marcados: [{
      starts_at: "2026-08-12T13:00:00-03:00",
      duration_minutes: 30,
      professional_id: null,
    }],
  });

  assertEquals(livres.includes("13:00"), false);
  assertEquals(livres.includes("13:30"), true);
  assertEquals(livres.includes("12:30"), true);
});

Deno.test("o mesmo horário continua livre com outro barbeiro na cadeira", () => {
  const { livres } = horariosLivres({
    ...base,
    equipe: [JORGE, MARCOS],
    marcados: [{
      starts_at: "2026-08-12T14:00:00-03:00",
      duration_minutes: 30,
      professional_id: "jorge",
    }],
  });

  // Uma cadeira ocupada não fecha a hora: o Marcos está livre.
  assertEquals(livres.includes("14:00"), true);
});

Deno.test("quem entra às 13h não aparece de manhã, e o resto aparece", () => {
  const { livres, porPessoa } = horariosLivres({
    ...base,
    equipe: [JORGE, MARCOS],
  });

  // A casa abre às 9h porque o Marcos está lá.
  assertEquals(livres.includes("09:00"), true);
  // E o Jorge é a exceção que precisa ser dita.
  assertEquals(porPessoa?.Jorge?.startsWith("13:00 13:30"), true);
  assertEquals(porPessoa?.Jorge?.includes("09:00"), false);
  // O Marcos pega tudo, então não repete a lista inteira.
  assertEquals(porPessoa?.Marcos, undefined);
});

Deno.test("14h com quem trabalha 13h-19h é horário livre", () => {
  const { porPessoa } = horariosLivres({ ...base, equipe: [JORGE, MARCOS] });

  // A falha medida em 2026/08/10, agora em código: "só começa às 13h" era
  // verdade e não respondia o pedido, que era das 14h.
  assertEquals(porPessoa?.Jorge?.includes("14:00"), true);
});

Deno.test("folga de uma pessoa não fecha a loja", () => {
  const { livres, porPessoa } = horariosLivres({
    ...base,
    equipe: [JORGE, MARCOS],
    folgas: [{
      professional_id: "jorge",
      starts_at: "2026-08-12T13:00:00-03:00",
      ends_at: "2026-08-12T15:00:00-03:00",
    }] as never,
  });

  assertEquals(livres.includes("13:00"), true);
  assertEquals(porPessoa?.Jorge?.includes("13:00"), false);
  assertEquals(porPessoa?.Jorge?.includes("15:00"), true);
});

Deno.test("feriado da casa não deixa nada", () => {
  const { livres } = horariosLivres({
    ...base,
    equipe: [JORGE, MARCOS],
    folgas: [{
      professional_id: null,
      starts_at: "2026-08-12T00:00:00-03:00",
      ends_at: "2026-08-13T00:00:00-03:00",
    }] as never,
  });

  assertEquals(livres, []);
});

Deno.test("quem não tem hora nenhuma no dia sai dito, e não omitido", () => {
  const { porPessoa } = horariosLivres({
    ...base,
    equipe: [JORGE, MARCOS],
    folgas: [{
      professional_id: "jorge",
      starts_at: "2026-08-12T00:00:00-03:00",
      ends_at: "2026-08-13T00:00:00-03:00",
    }] as never,
  });

  assertEquals(porPessoa?.Jorge, "none");
});

Deno.test("serviço de uma hora não cabe na última meia hora", () => {
  const { livres } = horariosLivres({ ...base, minutes: 60 });

  assertEquals(livres.at(-1), "18:00");
});

Deno.test("o intervalo entre atendimentos entra na conta", () => {
  const { livres } = horariosLivres({
    ...base,
    config: { buffer_minutes: 10, default_minutes: 30 },
    marcados: [{
      starts_at: "2026-08-12T13:00:00-03:00",
      duration_minutes: 30,
      professional_id: null,
    }],
  });

  // 13:00-13:30 mais dez minutos de arrumar: 13:30 deixa de caber.
  assertEquals(livres.includes("13:30"), false);
  assertEquals(livres.includes("14:00"), true);
});

Deno.test("hora que já passou não é hora livre", () => {
  const { livres } = horariosLivres({
    ...base,
    agora: new Date("2026-08-12T14:10:00-03:00"),
  });

  assertEquals(livres.includes("14:00"), false);
  assertEquals(livres[0], "14:30");
});
