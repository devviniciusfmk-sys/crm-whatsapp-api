import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { ADAPTADORES } from "./provedores.ts";

/**
 * # A porta dos pagamentos
 *
 * O gateway avisa aqui que uma fatura foi paga, e este arquivo faz três coisas
 * e mais nada: confere que o aviso é legítimo, traduz para o nosso vocabulário
 * e chama `billing.registrar_pagamento`.
 *
 *   POST /pagamentos/amplopay
 *
 * ## Isolado de propósito
 *
 * É uma função de borda separada, sem nenhuma ligação com o assistente ou com
 * as conversas. Um gateway fora do ar, um adaptador errado ou um postback
 * malformado não podem parar o atendimento — que é o produto. O pior que
 * acontece aqui é uma fatura demorar a ser quitada, e isso um humano resolve
 * olhando o extrato, como já fazia.
 *
 * ## Sempre 200, quase sempre
 *
 * Gateway que recebe erro reenvia — de minuto em minuto, por dias. Então:
 *
 *   - evento que não interessa       → 200, e nada acontece
 *   - assinatura errada              → 401, e ele DEVE parar
 *   - provedor desconhecido          → 404
 *   - fatura que não existe          → 200 com aviso no log
 *
 * Só a assinatura errada recusa, porque ali reenviar não vai ajudar e insistir
 * é o que um ataque faria.
 *
 * ## O que este arquivo não decide
 *
 * Se quita, se é repetido, se o valor bate. Tudo isso é do banco, em
 * `billing.registrar_pagamento`, que devolve o mesmo pagamento quando o
 * postback vem duas vezes em vez de criar o segundo. Decidir aqui seria um
 * segundo lugar decidindo dinheiro. - 2026/08/19
 */

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const qual = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const adaptador = ADAPTADORES[qual];

  if (!adaptador) {
    return new Response(
      JSON.stringify({ erro: `provedor desconhecido: ${qual}` }),
      { status: 404, headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  }

  /* O corpo lido UMA vez, como texto: assinaturas se conferem sobre os bytes
   * originais, e `req.json()` já teria consumido o fluxo. */
  const corpo = await req.text();

  const segredo = Deno.env.get(`PAGAMENTOS_${qual.toUpperCase()}_SEGREDO`) ?? "";

  if (!adaptador.confere(req, corpo, segredo)) {
    console.warn(`[pagamentos] assinatura recusada em ${qual}`);

    return new Response(JSON.stringify({ erro: "assinatura inválida" }), {
      status: 401,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  let aviso;

  try {
    aviso = adaptador.ler(JSON.parse(corpo));
  } catch {
    console.warn(`[pagamentos] corpo ilegível em ${qual}: ${corpo.slice(0, 300)}`);
    aviso = null;
  }

  if (!aviso) {
    // Não é erro: gateways avisam de tudo, e 200 evita reenvio eterno do que
    // nunca vai interessar.
    return new Response(JSON.stringify({ ignorado: true }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  if (aviso.situacao !== "pago") {
    console.info(`[pagamentos] ${qual}: ${aviso.transacao} está ${aviso.situacao}`);

    return new Response(JSON.stringify({ situacao: aviso.situacao }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const { data, error } = await client.schema("billing").rpc(
    "registrar_pagamento",
    {
      _invoice_id: aviso.fatura,
      _amount: aviso.valor,
      _method: qual,
      _external_id: aviso.transacao,
    },
  );

  if (error) {
    /* Fatura inexistente é o caso comum e não merece 500: acontece quando a
     * referência foi digitada errada no painel, ou quando o postback é de uma
     * cobrança criada fora daqui. Fica no log com os dados para achar. */
    console.error(
      `[pagamentos] ${qual} não registrou`,
      { fatura: aviso.fatura, transacao: aviso.transacao, erro: error.message },
    );

    return new Response(JSON.stringify({ erro: error.message }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  console.info(
    `[pagamentos] ${qual}: fatura ${aviso.fatura} recebeu R$ ${aviso.valor}`,
  );

  return new Response(JSON.stringify({ pagamento: data }), {
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});
