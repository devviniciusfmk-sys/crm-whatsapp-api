import { assertEquals } from "jsr:@std/assert";
import { amplopay } from "./provedores.ts";

/**
 * O adaptador tem UMA responsabilidade: traduzir sem inventar.
 *
 * Estes testes cobrem o que mais dói se estiver errado — valor em centavos
 * lido como reais (cobra cem vezes menos) e postback estranho virando
 * pagamento em vez de ser ignorado.
 */

const req = (headers: Record<string, string> = {}, url = "https://x/amplopay") =>
  new Request(url, { method: "POST", headers });

Deno.test("recusa sem segredo configurado", () => {
  assertEquals(amplopay.confere(req({ "x-webhook-secret": "abc" }), "", ""), false);
});

Deno.test("aceita o segredo no cabeçalho", () => {
  assertEquals(
    amplopay.confere(req({ "x-webhook-secret": "abc" }), "", "abc"),
    true,
  );
});

Deno.test("aceita o segredo como Bearer", () => {
  assertEquals(
    amplopay.confere(req({ authorization: "Bearer abc" }), "", "abc"),
    true,
  );
});

Deno.test("aceita o segredo na URL", () => {
  assertEquals(
    amplopay.confere(req({}, "https://x/amplopay?token=abc"), "", "abc"),
    true,
  );
});

Deno.test("recusa segredo errado", () => {
  assertEquals(
    amplopay.confere(req({ "x-webhook-secret": "outro" }), "", "abc"),
    false,
  );
});

Deno.test("lê uma venda aprovada", () => {
  const aviso = amplopay.ler({
    data: {
      id: "tx_123",
      external_reference: "78b286f3-0b47-4345-a2a0-684e758bb6b8",
      status: "paid",
      amount: 9700,
    },
  })!;

  assertEquals(aviso.transacao, "tx_123");
  assertEquals(aviso.fatura, "78b286f3-0b47-4345-a2a0-684e758bb6b8");
  assertEquals(aviso.situacao, "pago");
  // `amount` é centavos: 9700 são R$ 97,00 e não noventa e sete mil.
  assertEquals(aviso.valor, 97);
});

Deno.test("`value` vem em reais, e não em centavos", () => {
  const aviso = amplopay.ler({
    id: "tx_9",
    reference: "abc",
    status: "aprovado",
    value: "97,50",
  })!;

  assertEquals(aviso.valor, 97.5);
});

Deno.test("estorno e recusa não viram pagamento", () => {
  for (const [bruto, esperado] of [
    ["refunded", "estornado"],
    ["chargeback", "estornado"],
    ["refused", "recusado"],
    ["canceled", "recusado"],
    ["waiting_payment", "pendente"],
  ] as const) {
    const aviso = amplopay.ler({ id: "t", reference: "f", status: bruto })!;

    assertEquals(aviso.situacao, esperado, bruto);
  }
});

Deno.test("sem referência ou sem transação, não entende — e diz isso", () => {
  // Devolver null é diferente de devolver um aviso vazio: quem chama responde
  // 200 e ignora, em vez de tentar registrar pagamento de fatura nenhuma.
  assertEquals(amplopay.ler({ id: "tx_1", status: "paid" }), null);
  assertEquals(amplopay.ler({ reference: "abc", status: "paid" }), null);
  assertEquals(amplopay.ler({ evento: "ping" }), null);
});
