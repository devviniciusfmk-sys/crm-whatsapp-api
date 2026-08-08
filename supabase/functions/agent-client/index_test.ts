import { assertEquals } from "jsr:@std/assert@1";
import { PROMISE_OF_A_PERSON } from "./index.ts";

/**
 * A promessa que precisa de gente, e a que o assistente cumpre sozinho.
 *
 * Casar texto é frágil por natureza; o teste existe para que a fragilidade
 * fique num lugar onde ela grita. Run with `deno test` from `supabase/functions`.
 */
Deno.test("promessa de terceiro é reconhecida", () => {
  for (
    const frase of [
      "Oi, o valor do corte eu confirmo com a equipe e já te retorno.",
      "Vou chamar um colega para te ajudar.",
      "Deixa que eu verifico isso com a responsável.",
      "Assim que a equipe confirmar eu te aviso.",
      "Vou passar para uma pessoa do time.",
      // Medidas em produção em 2026/08/08, numa sondagem de seis perguntas.
      "Um momento, estou transferindo sua solicitação para um colega.",
      "Vou transferir você para alguém do salão.",
      // Esta escapava: o verbo não está colado no "com", e "retorno" vem sem
      // o "te". Foi a única perdida em seis, medida em 2026/08/08.
      "Confirmando o valor com a equipe, já retorno pra você.",
      "Preciso checar isso tudo com o responsável.",
    ]
  ) {
    assertEquals(PROMISE_OF_A_PERSON.test(frase), true, frase);
  }
});

Deno.test("o que o assistente cumpre sozinho não conta", () => {
  for (
    const frase of [
      "Já verifico a agenda e te digo os horários livres.",
      "Confirmo o corte para 08/08 às 14h?",
      "Vou marcar para sexta às 10h.",
      "Seu horário está confirmado, qualquer coisa é só chamar.",
      // A folga de três palavras entre o verbo e o "com" não pode transformar
      // qualquer frase que tenha "confirmar" e "com" em promessa de terceiro.
      "Confirmo seu corte de sexta com antecedência de um dia.",
      "Vou marcar com meia hora de folga entre um cliente e outro.",
    ]
  ) {
    assertEquals(PROMISE_OF_A_PERSON.test(frase), false, frase);
  }
});
