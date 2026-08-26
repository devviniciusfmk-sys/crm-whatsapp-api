import { assertEquals } from "jsr:@std/assert@1";
import { porQueNaoResponder } from "./grupo.ts";

/**
 * O assistente cala em grupo, e continua falando com quem escreve sozinho.
 *
 * Este teste existe porque o defeito que ele guarda não é observável hoje: não
 * há uma única conversa de grupo no banco, e não vai haver enquanto a ponte
 * não subir. Ou seja, a regressão aqui passaria por todas as suítes de ponta a
 * ponta e só apareceria na frente dos clientes do usuário, dentro do grupo
 * dele. Teste de coisa que ainda não acontece é o único jeito de essa hora não
 * ser a primeira vez.
 *
 *   cd supabase/functions && deno test --allow-all agent-client/grupo_test.ts
 */
Deno.test("mensagem de grupo cala o assistente", () => {
  assertEquals(
    porQueNaoResponder({
      group_address: "120363000000000000@g.us",
      contact_address: null,
    }),
    "grupo",
  );
});

Deno.test("grupo é grupo mesmo com remetente conhecido", () => {
  /* A ponte pode mandar as duas coisas: o grupo, e quem falou dentro dele.
   * Se a razão fosse "não tem contato", este caso passaria batido — e é
   * justamente o formato mais provável de chegar. */
  assertEquals(
    porQueNaoResponder({
      group_address: "120363000000000000@g.us",
      contact_address: "5511999999999",
    }),
    "grupo",
  );
});

Deno.test("conversa sem endereço nenhum não tem para onde responder", () => {
  assertEquals(
    porQueNaoResponder({ group_address: null, contact_address: null }),
    "sem-destinatario",
  );
});

Deno.test("conversa de uma pessoa só continua sendo respondida", () => {
  /* O caso que importa mais: uma trava boa demais silencia o produto inteiro,
   * e o sintoma — "o robô parou de responder" — é o mesmo de dez outras
   * causas. Sem esta linha, `return "grupo"` sempre passaria nos três casos
   * acima. */
  assertEquals(
    porQueNaoResponder({
      group_address: null,
      contact_address: "5511999999999",
    }),
    null,
  );
});

Deno.test("campo ausente é tão nulo quanto nulo", () => {
  /* A linha vem do banco por `select *`, mas o tipo aceita os campos
   * opcionais, e `undefined` não é `null` em JavaScript para quem escreve
   * `=== null`. Aqui é `!`, e este caso é o que garante que continue sendo. */
  assertEquals(porQueNaoResponder({}), "sem-destinatario");
  assertEquals(
    porQueNaoResponder({ contact_address: "5511999999999" }),
    null,
  );
});
