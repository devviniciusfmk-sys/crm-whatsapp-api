import { assertEquals } from "jsr:@std/assert@1";
import {
  tipoEhGenerico,
  tipoParaGuardar,
  tipoPelosBytes,
} from "./tipo_pelos_bytes.ts";

/**
 * Um rótulo errado é pior que rótulo nenhum: o navegador confia nele e não o
 * desmente. Por isso metade destes casos verifica o que a função se RECUSA a
 * afirmar.
 *
 *   cd supabase/functions && deno test --allow-all _shared/tipo_pelos_bytes_test.ts
 */

/** Monta um cabeçalho com a assinatura no começo e enchimento depois. */
const cabecalho = (...bytes: (number | string)[]) => {
  const achatados: number[] = [];

  for (const b of bytes) {
    if (typeof b === "number") achatados.push(b);
    else for (const c of b) achatados.push(c.charCodeAt(0));
  }

  return new Uint8Array([...achatados, ...new Array(64).fill(0)]);
};

Deno.test("mp4 se reconhece pelo ftyp", () => {
  assertEquals(
    tipoPelosBytes(cabecalho(0, 0, 0, 0x20, "ftypisom")),
    "video/mp4",
  );
});

Deno.test("m4a NÃO é vídeo, mesmo com o mesmo contêiner", () => {
  /* mp4, m4a e mov dividem o `ftyp`. Sem a segunda olhada, uma mensagem de voz
   * viraria `video/mp4` e a tela tentaria desenhar um quadro de um arquivo que
   * não tem imagem nenhuma. */
  assertEquals(
    tipoPelosBytes(cabecalho(0, 0, 0, 0x20, "ftypM4A ")),
    "audio/mp4",
  );
});

Deno.test("o áudio do WhatsApp é ogg/opus, com o codec junto", () => {
  /* O `codecs=opus` não é enfeite: é como o navegador escolhe o decodificador.
   * Um `audio/ogg` pelado toca na maioria dos casos e falha em alguns. */
  const ogg = new Uint8Array([
    ...[0x4f, 0x67, 0x67, 0x53],
    ...new Array(24).fill(0),
    ...[..."OpusHead"].map((c) => c.charCodeAt(0)),
    ...new Array(32).fill(0),
  ]);

  assertEquals(tipoPelosBytes(ogg), "audio/ogg; codecs=opus");
});

Deno.test("ogg sem Opus continua sendo ogg", () => {
  assertEquals(
    tipoPelosBytes(cabecalho(0x4f, 0x67, 0x67, 0x53)),
    "audio/ogg",
  );
});

Deno.test("webp e wav dividem o RIFF e não se confundem", () => {
  /* Os dois começam com os mesmos quatro bytes. Confundi-los transformaria uma
   * figurinha em áudio e vice-versa — os dois falham calados. */
  assertEquals(tipoPelosBytes(cabecalho("RIFF", 0, 0, 0, 0, "WEBP")), "image/webp");
  assertEquals(tipoPelosBytes(cabecalho("RIFF", 0, 0, 0, 0, "WAVE")), "audio/wav");
});

Deno.test("as imagens comuns", () => {
  assertEquals(tipoPelosBytes(cabecalho(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assertEquals(
    tipoPelosBytes(cabecalho(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    "image/png",
  );
  assertEquals(tipoPelosBytes(cabecalho("GIF89a")), "image/gif");
});

Deno.test("pdf e webm", () => {
  assertEquals(tipoPelosBytes(cabecalho("%PDF-1.7")), "application/pdf");
  assertEquals(
    tipoPelosBytes(cabecalho(0x1a, 0x45, 0xdf, 0xa3)),
    "video/webm",
  );
});

Deno.test("o que não se reconhece NÃO recebe palpite", () => {
  /* O caso mais importante do arquivo. Um formato fora da lista tem de sair
   * como estava — genérico —, e não como o primeiro tipo que quase encaixou.
   * Rótulo errado o navegador não desmente. */
  assertEquals(tipoPelosBytes(cabecalho(0x12, 0x34, 0x56, 0x78)), undefined);
  assertEquals(tipoPelosBytes(new Uint8Array([])), undefined);
  assertEquals(tipoPelosBytes(new Uint8Array([0xff])), undefined);
});

Deno.test("quem já veio com tipo específico continua com o dele", () => {
  /* Quem enviou sabe mais que uma tabela de assinaturas: um `image/svg+xml`
   * nunca seria adivinhado, e sobrescrevê-lo por palpite seria perder
   * informação boa. */
  assertEquals(
    tipoParaGuardar("image/svg+xml", cabecalho(0x3c, 0x3f, 0x78, 0x6d)),
    "image/svg+xml",
  );
});

Deno.test("o genérico é que abre espaço para os bytes", () => {
  const mp4 = cabecalho(0, 0, 0, 0x20, "ftypisom");

  assertEquals(tipoParaGuardar("application/octet-stream", mp4), "video/mp4");
  assertEquals(tipoParaGuardar("", mp4), "video/mp4");
  assertEquals(tipoParaGuardar(undefined, mp4), "video/mp4");
  /* O padrão que o cliente do Storage inventa quando ninguém passa nada. */
  assertEquals(tipoParaGuardar("text/plain;charset=UTF-8", mp4), "video/mp4");
});

Deno.test("genérico e irreconhecível some, e o Storage decide como antes", () => {
  assertEquals(
    tipoParaGuardar("application/octet-stream", cabecalho(0x12, 0x34)),
    undefined,
  );
});

Deno.test("tipoEhGenerico não confunde maiúsculas", () => {
  assertEquals(tipoEhGenerico("APPLICATION/OCTET-STREAM"), true);
  assertEquals(tipoEhGenerico("  application/octet-stream  "), true);
  assertEquals(tipoEhGenerico("video/mp4"), false);
});
