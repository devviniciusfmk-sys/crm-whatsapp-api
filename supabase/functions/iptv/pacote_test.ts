import { assertEquals } from "jsr:@std/assert";
import { escolherPacote } from "./pacote.ts";

/**
 * O caso é o da base do piloto: um plano pronto e um vazio, no mesmo servidor.
 *
 * Ali o bom era o mais antigo e ninguém percebeu. Estes testes existem para
 * que a ordem de criação deixe de decidir se o módulo funciona.
 */
const PRONTO = {
  name: "Teste 2h completo",
  bot_url: "https://sharks10.top/api/chatbot/RYAWRk1jlx/ANKWPKDPRq",
  bot_path: null,
};

const VAZIO = { name: "Novo pacote", bot_url: null, bot_path: null };

Deno.test("o plano vazio veio primeiro e mesmo assim não é o escolhido", () => {
  assertEquals(escolherPacote([VAZIO, PRONTO])?.name, "Teste 2h completo");
});

Deno.test("na outra ordem, o mesmo", () => {
  assertEquals(escolherPacote([PRONTO, VAZIO])?.name, "Teste 2h completo");
});

Deno.test("o caminho pelo `bot_path` também conta como ter link", () => {
  const porPath = { name: "Mensal", bot_url: null, bot_path: "mensal" };

  assertEquals(escolherPacote([VAZIO, porPath])?.name, "Mensal");
});

Deno.test("espaço em branco não é link", () => {
  const soEspaco = { name: "Torto", bot_url: "   ", bot_path: "  " };

  assertEquals(escolherPacote([soEspaco, PRONTO])?.name, "Teste 2h completo");
});

Deno.test("nenhum com link devolve o primeiro, e não `undefined`", () => {
  /* Para o 409 continuar falando do plano que a pessoa vê primeiro. Devolver
   * nada aqui viraria "nenhum pacote ativo" numa loja que tem dois. */
  assertEquals(escolherPacote([VAZIO])?.name, "Novo pacote");
});

Deno.test("lista vazia ou ausente não explode", () => {
  assertEquals(escolherPacote([]), undefined);
  assertEquals(escolherPacote(null), undefined);
  assertEquals(escolherPacote(undefined), undefined);
});
