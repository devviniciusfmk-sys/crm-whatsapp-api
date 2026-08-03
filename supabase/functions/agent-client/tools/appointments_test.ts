import { assertEquals } from "jsr:@std/assert";
import {
  findOverlap,
  fitsOpeningHours,
  localToUtc,
  minutesFor,
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
    { name: "Corte", minutes: 30 },
    { name: "Coloração", minutes: 120 },
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
