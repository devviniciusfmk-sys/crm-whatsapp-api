import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { ADAPTADORES } from "./provedores.ts";
import { confirmacaoDePagamento } from "../_shared/confirmacao_de_pagamento.ts";

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

  /**
   * Dois destinos, e a referência diz qual.
   *
   * `cob:` é uma cobrança da loja para um cliente dela — o corte de cabelo, o
   * plano. `fat:` (ou uma referência sem prefixo, que é o formato antigo) é a
   * fatura da mensalidade que a loja paga.
   *
   * São dois dinheiros com dois donos e duas tabelas, e o postback chega pela
   * mesma porta. Adivinhar pelo formato do id seria adivinhar sobre dinheiro:
   * os dois são uuid, e errar manda o pagamento do cliente para a fatura da
   * loja. Quem cria a cobrança no gateway é quem escreve o prefixo. - 2026/08/19
   */
  const deCliente = aviso.fatura.startsWith("cob:");
  const alvo = aviso.fatura.replace(/^(cob|fat):/, "");

  const { data, error } = deCliente
    ? await client.rpc("quitar_cobranca", {
      _cobranca: alvo,
      _metodo: qual,
      _external_id: aviso.transacao,
    })
    : await client.schema("billing").rpc("registrar_pagamento", {
      _invoice_id: alvo,
      _amount: aviso.valor,
      _method: qual,
      _external_id: aviso.transacao,
    });

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

  /**
   * A confirmação sai sozinha, e é o ponto de tudo isto.
   *
   * Quem paga fica sem saber se chegou: o extrato dele diz que saiu, nada diz
   * que a loja viu. Aqui não há ninguém para responder "recebi" — é justamente
   * o que a automação promete.
   *
   * Só para cobrança de cliente. A fatura da mensalidade é da LOJA, não tem
   * conversa do outro lado, e mandar "pagamento confirmado" para o WhatsApp
   * dela seria o sistema conversando consigo mesmo.
   */
  if (deCliente && data) {
    const cobranca = data as unknown as {
      conversation_id: string;
      organization_id: string;
      contact_address: string;
      itens?: { nome: string; valor: number }[];
      valor: number;
      vence_em?: string | null;
    };

    try {
      const { data: conv } = await client
        .from("conversations")
        .select("id, name, service, organization_address, contact_address")
        .eq("id", cobranca.conversation_id)
        .single();

      const { data: org } = await client
        .from("organizations")
        .select("name")
        .eq("id", cobranca.organization_id)
        .single();

      if (conv) {
        await client.from("messages").insert({
          conversation_id: conv.id,
          organization_id: cobranca.organization_id,
          organization_address: conv.organization_address,
          service: conv.service,
          contact_address: conv.contact_address,
          direction: "outgoing",
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text: confirmacaoDePagamento(
              cobranca,
              org?.name ?? undefined,
              conv.name?.split(" ")[0] ?? undefined,
            ),
          },
        });
      }
    } catch (erro) {
      /* Avisar que falha não desfaz o pagamento: o dinheiro entrou e a
       * cobrança está quitada, que é o fato. O cliente sem confirmação volta a
       * perguntar "recebeu?" — chato, e muito melhor que uma cobrança que o
       * gateway pagou e o sistema não registrou. */
      console.error(`[pagamentos] pago, mas sem avisar o cliente`, erro);
    }
  }

  console.info(
    `[pagamentos] ${qual}: ${deCliente ? "cobrança" : "fatura"} ${alvo} recebeu R$ ${aviso.valor}`,
  );

  return new Response(JSON.stringify({ pagamento: data }), {
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
});
