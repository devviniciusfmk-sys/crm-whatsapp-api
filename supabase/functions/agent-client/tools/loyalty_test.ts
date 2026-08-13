import { assertEquals } from "jsr:@std/assert";
import { desdeAUltimaCortesia, posicaoNoCartao } from "./loyalty.ts";

/**
 * A conta do cartão, que é onde dá para errar sem ninguém notar.
 *
 * A primeira versão usava o resto da divisão, e ela só acerta se todo prêmio
 * for consumido exatamente no múltiplo — o que a vida não faz. O cliente
 * esquece de pedir e usa no décimo segundo; o balcão dá a cortesia no nono
 * porque ele reclamou. Contando a partir do RESGATE, o cartão diz a verdade em
 * qualquer um desses casos.
 *
 * O defeito que estes testes existem para pegar é o do cliente ganhando duas
 * vezes pelo mesmo décimo. Ele não quebra nada, não aparece em log nenhum, e a
 * loja só descobre quando alguém repara que fulano nunca paga. - 2026/08/13
 */

const pago = { extra: { payment_method: "cash" } };
const cortesia = { extra: { payment_method: "courtesy" } };
const semRegistro = { extra: null };

Deno.test("sem nenhuma cortesia, conta tudo", () => {
  assertEquals(desdeAUltimaCortesia([pago, pago, pago]), 3);
});

Deno.test("atendimento sem forma de pagamento ainda conta para o cartão", () => {
  // Quem não preencheu o caixa não perde a visita: o cartão é do cliente, e o
  // esquecimento é do balcão.
  assertEquals(desdeAUltimaCortesia([pago, semRegistro, pago]), 3);
});

Deno.test("a cortesia zera, e ela mesma não conta para o cartão seguinte", () => {
  assertEquals(desdeAUltimaCortesia([pago, pago, cortesia]), 0);
});

Deno.test("depois da cortesia, recomeça do zero", () => {
  assertEquals(desdeAUltimaCortesia([pago, cortesia, pago, pago]), 2);
});

Deno.test("duas cortesias: vale a última", () => {
  assertEquals(
    desdeAUltimaCortesia([pago, cortesia, pago, pago, cortesia, pago]),
    1,
  );
});

Deno.test("no alvo, chegou", () => {
  assertEquals(posicaoNoCartao(10, 10), { noCartao: 10, alvo: 10, chegou: true });
});

Deno.test("no meio do cartão, não chegou", () => {
  assertEquals(posicaoNoCartao(7, 10), { noCartao: 7, alvo: 10, chegou: false });
});

Deno.test("passar do alvo continua valendo, e não trunca", () => {
  // Quem fez doze sem pedir a cortesia tem direito a ela, e ver "12 de 10" é o
  // que conta que ele deixou duas passar. Truncar esconderia isso.
  assertEquals(posicaoNoCartao(12, 10), {
    noCartao: 12,
    alvo: 10,
    chegou: true,
  });
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
