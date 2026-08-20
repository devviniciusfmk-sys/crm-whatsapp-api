import { assertEquals } from "jsr:@std/assert";
import { amplopay } from "./provedores.ts";

/**
 * O adaptador tem UMA responsabilidade: traduzir sem inventar.
 *
 * ## Por que estes testes mudaram inteiros
 *
 * A primeira versão foi escrita ANTES da documentação da AmploPay abrir, e
 * testava o que eu tinha suposto: valor em centavos, referência chamada
 * `external_reference`, segredo em cabeçalho. Os três estavam errados — e os
 * testes passavam do mesmo jeito, porque conferiam o adaptador contra a minha
 * suposição em vez de contra o gateway.
 *
 * Teste que confirma o palpite de quem o escreveu não protege de nada. Ele só
 * transforma um erro em um erro com selo de aprovado.
 *
 * Estes falam a forma documentada em `app.amplopay.com/docs`, e é por isso que
 * os números aqui parecem pequenos: `amount: 97` são noventa e sete reais.
 */

const req = (headers: Record<string, string> = {}, url = "https://x/amplopay") =>
  new Request(url, { method: "POST", headers });

/** Um postback como a AmploPay manda. */
const postback = (
  transacao: Record<string, unknown>,
  evento = "TRANSACTION_PAID",
) => JSON.stringify({ event: evento, token: "abc", transaction: transacao });

Deno.test("recusa quando não há segredo configurado", () => {
  // Segredo vazio combinando com cabeçalho vazio abriria a porta para quem
  // simplesmente não mandasse nada.
  assertEquals(amplopay.confere(req({ "x-webhook-secret": "abc" }), "", ""), false);
  assertEquals(amplopay.confere(req(), postback({ id: "t" }), ""), false);
});

Deno.test("aceita o token do corpo, que é o jeito da AmploPay", () => {
  assertEquals(amplopay.confere(req(), postback({ id: "t" }), "abc"), true);
});

Deno.test("recusa o token errado", () => {
  const outro = JSON.stringify({ event: "TRANSACTION_PAID", token: "chute" });

  assertEquals(amplopay.confere(req(), outro, "abc"), false);
});

Deno.test("corpo ilegível não derruba a conferência", () => {
  // Sem o `try`, um corpo quebrado viraria exceção antes do 401 — e o gateway
  // receberia 500 e reenviaria para sempre.
  assertEquals(amplopay.confere(req(), "isto não é json {{{", "abc"), false);
});

Deno.test("o cabeçalho e a URL continuam valendo, como rede", () => {
  assertEquals(amplopay.confere(req({ "x-webhook-secret": "abc" }), "", "abc"), true);
  assertEquals(amplopay.confere(req({ authorization: "Bearer abc" }), "", "abc"), true);
  assertEquals(
    amplopay.confere(req({}, "https://x/amplopay?token=abc"), "", "abc"),
    true,
  );
});

Deno.test("lê um pagamento aprovado, com o valor em reais", () => {
  const aviso = amplopay.ler(JSON.parse(postback({
    id: "cmry2h8332sgs3ub44fh7",
    clientIdentifier: "cob:78b286f3-0b47-4345-a2a0-684e758bb6b8",
    status: "COMPLETED",
    amount: 97,
  })))!;

  assertEquals(aviso.transacao, "cmry2h8332sgs3ub44fh7");
  assertEquals(aviso.fatura, "cob:78b286f3-0b47-4345-a2a0-684e758bb6b8");
  assertEquals(aviso.situacao, "pago");
  // Noventa e sete reais. Lidos como centavos, seriam noventa e sete centavos.
  assertEquals(aviso.valor, 97);
});

Deno.test("a referência é `clientIdentifier` na volta, e não `identifier`", () => {
  // Mandamos `identifier` na criação; a resposta e o postback chamam de
  // `clientIdentifier`. Procurar pelo nome de ida acha nada, e cobrança sem
  // referência é cobrança que nunca fecha sozinha.
  const aviso = amplopay.ler(JSON.parse(postback({
    id: "tx",
    clientIdentifier: "cob:abc",
    amount: 10,
  })))!;

  assertEquals(aviso.fatura, "cob:abc");
});

Deno.test("cada evento vira uma situação, e nenhum outro vira pago", () => {
  for (
    const [evento, esperado] of [
      ["TRANSACTION_CREATED", "pendente"],
      ["TRANSACTION_PAID", "pago"],
      ["TRANSACTION_CANCELED", "recusado"],
      ["TRANSACTION_REFUNDED", "estornado"],
      ["TRANSACTION_CHARGED_BACK", "estornado"],
      ["TRANSACTION_INVENTADO", "pendente"],
    ] as const
  ) {
    const aviso = amplopay.ler(JSON.parse(
      postback({ id: "t", clientIdentifier: "cob:f", amount: 10 }, evento),
    ))!;

    assertEquals(aviso.situacao, esperado, evento);
  }
});

Deno.test("sem evento, o status decide", () => {
  for (
    const [status, esperado] of [
      ["PENDING", "pendente"],
      ["COMPLETED", "pago"],
      ["FAILED", "recusado"],
      ["REFUNDED", "estornado"],
      ["CHARGED_BACK", "estornado"],
    ] as const
  ) {
    const aviso = amplopay.ler({
      transaction: { id: "t", clientIdentifier: "cob:f", status, amount: 10 },
    })!;

    assertEquals(aviso.situacao, esperado, status);
  }
});

Deno.test("valor escrito com vírgula", () => {
  const aviso = amplopay.ler(JSON.parse(postback({
    id: "tx_9",
    clientIdentifier: "fat:abc",
    amount: "97,50",
  })))!;

  assertEquals(aviso.valor, 97.5);
});

Deno.test("sem referência ou sem transação, não entende — e diz isso", () => {
  // Devolver null é diferente de devolver um aviso vazio: quem chama responde
  // 200 e ignora, em vez de tentar registrar pagamento de fatura nenhuma.
  assertEquals(amplopay.ler(JSON.parse(postback({ id: "tx_1" }))), null);
  assertEquals(amplopay.ler(JSON.parse(postback({ clientIdentifier: "cob:a" }))), null);
  assertEquals(amplopay.ler({ event: "ping" }), null);
});

Deno.test("a referência também é achada na raiz", () => {
  // Rede para um evento que chegue por outra rota deles, com o mesmo conteúdo
  // sem o embrulho de `transaction`.
  const aviso = amplopay.ler({
    event: "TRANSACTION_PAID",
    clientIdentifier: "cob:abc",
    transactionId: "tx_7",
    amount: 40,
  })!;

  assertEquals(aviso.fatura, "cob:abc");
  assertEquals(aviso.transacao, "tx_7");
  assertEquals(aviso.valor, 40);
});
