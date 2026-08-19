import { assertEquals } from "jsr:@std/assert";
import { podeIrAoCliente } from "./base.ts";

/**
 * O crivo do texto solto.
 *
 * De um lado o vazamento de 2026/08/04, que um cliente leu no WhatsApp. Do
 * outro os 5 clientes em 30 que ficaram mudos em 2026/08/10 com a resposta
 * certa escrita e descartada. Este arquivo é o lugar onde os dois casos ficam
 * lado a lado, e onde uma expressão nova é conferida contra os dois de uma vez.
 */

Deno.test("a resposta que foi jogada fora passa", () => {
  // As três medidas em 2026/08/10, palavra por palavra.
  assertEquals(
    podeIrAoCliente(
      "Um momento, estou transferindo sua conversa para um colega.",
    ),
    true,
  );
  assertEquals(
    podeIrAoCliente(
      "Oi Rita, confirmei sua manicure na quarta (12/08) às 13h. Estamos fechados agora, mas abrimos amanhã às 9h. Até mais!",
    ),
    true,
  );
  assertEquals(
    podeIrAoCliente(
      "Vou chamar um colega para te ajudar. Por favor, aguarde um momento.",
    ),
    true,
  );
});

Deno.test("o vazamento que o cliente leu continua barrado", () => {
  // Exatamente o que saiu em produção em 2026/08/04.
  assertEquals(
    podeIrAoCliente(
      "analysisWe have a user wanting to schedule a consulta for day 30. " +
        "They said 'dia 30'. Probably referring to August 30... Let's check " +
        'if Monday 31 is open.assistantcommentary to=functions.list_appointments json{"date":"2026-08-31"}',
    ),
    false,
  );
});

Deno.test("cada marca sozinha já barra", () => {
  assertEquals(podeIrAoCliente("analysis o cliente quer marcar"), false);
  assertEquals(podeIrAoCliente("assistantfinal Oi!"), false);
  assertEquals(podeIrAoCliente("<|channel|>final Oi!"), false);
  assertEquals(podeIrAoCliente('{"messages": ["Oi"]}'), false);
  assertEquals(podeIrAoCliente('tool_calls: respond("Oi")'), false);
  assertEquals(podeIrAoCliente('{"name": "respond"}'), false);
});

Deno.test("monólogo não é resposta de atendimento", () => {
  assertEquals(podeIrAoCliente("Oi! ".repeat(400)), false);
});

Deno.test("vazio não vai a lugar nenhum", () => {
  assertEquals(podeIrAoCliente(""), false);
  assertEquals(podeIrAoCliente("   \n  "), false);
});

Deno.test("uma palavra parecida no meio de uma frase de verdade não barra", () => {
  // "análise" com acento é português de gente, e não o canal do modelo.
  assertEquals(
    podeIrAoCliente(
      "Fizemos a análise do seu cabelo e recomendamos hidratação.",
    ),
    true,
  );
});
