import { assertEquals } from "jsr:@std/assert";
import { posicaoNoCartao } from "./loyalty.ts";

/**
 * A conta do cartão, que é onde dá para errar sem ninguém notar.
 *
 * O erro que estes testes existem para pegar é o do múltiplo exato: com dez
 * atendimentos e cartão de dez, o resto da divisão é ZERO — e a leitura ingênua
 * diz "0 de 10", ou seja, avisa o cliente que ele está no começo justamente no
 * dia em que ele fechou o cartão. É um defeito que não quebra nada, não aparece
 * em log nenhum, e faz o programa de fidelidade nunca pagar. - 2026/08/13
 */

Deno.test("no meio do cartão, conta o que andou", () => {
  assertEquals(posicaoNoCartao(7, 10), { noCartao: 7, alvo: 10, chegou: false });
});

Deno.test("no múltiplo exato, o cartão está CHEIO e não vazio", () => {
  assertEquals(posicaoNoCartao(10, 10), { noCartao: 10, alvo: 10, chegou: true });
});

Deno.test("passado o primeiro cartão, recomeça a contagem", () => {
  assertEquals(posicaoNoCartao(13, 10), { noCartao: 3, alvo: 10, chegou: false });
});

Deno.test("o segundo cartão também fecha", () => {
  assertEquals(posicaoNoCartao(20, 10), { noCartao: 10, alvo: 10, chegou: true });
});

Deno.test("quem nunca veio está em zero, e não chegou a nada", () => {
  assertEquals(posicaoNoCartao(0, 10), { noCartao: 0, alvo: 10, chegou: false });
});

Deno.test("sem cartão configurado não há posição", () => {
  assertEquals(posicaoNoCartao(9, undefined), null);
  assertEquals(posicaoNoCartao(9, 0), null);
});

Deno.test("cartão de um seria uma cortesia por visita: não vale", () => {
  assertEquals(posicaoNoCartao(5, 1), null);
});
