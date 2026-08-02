import { assertEquals } from "jsr:@std/assert";
import { localToUtc, utcToLocal } from "./appointments.ts";

/**
 * O fuso é o que este arquivo protege.
 *
 * Um erro de três horas aqui não quebra nada visivelmente: o compromisso é
 * gravado, a tela mostra um horário, e só o cliente que aparece na hora errada
 * descobre. É exatamente o tipo de falha que teste pega e revisão não.
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
