import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { ADAPTADORES } from "./provedores.ts";
import { criarCobranca, lerCheckout, lerSituacao } from "./checkout.ts";
import { ErroDoGateway, testarAmploPay } from "./criar.ts";
import { confirmacaoDePagamento } from "../_shared/confirmacao_de_pagamento.ts";

/**
 * # A porta dos pagamentos
 *
 * Duas famílias de rota, olhando para lados opostos do mesmo dinheiro.
 *
 *   GET  /pagamentos/checkout?org=…       o que a loja vende
 *   POST /pagamentos/cobrar               o cliente pede um Pix
 *   GET  /pagamentos/situacao?cobranca=…  já pagou?
 *   POST /pagamentos/amplopay             o gateway avisa que pagou
 *
 * As três primeiras são o cliente da loja, sem login, num navegador. A última é
 * o gateway. Moram juntas porque compartilham o essencial — as credenciais e a
 * tabela de cobranças — e separá-las seria duas funções lendo o mesmo segredo.
 *
 * O postback é o que este cabeçalho descreve daqui para baixo: confere que o
 * aviso é legítimo, traduz para o nosso vocabulário e chama quem registra. O
 * checkout está em `checkout.ts`, com as suas próprias regras.
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

  /**
   * O checkout entra ANTES da tabela de adaptadores.
   *
   * As duas famílias de rota moram na mesma função porque compartilham o
   * essencial — as credenciais do gateway e a tabela de cobranças — e separá-las
   * significaria duas funções lendo o mesmo segredo. Mas elas olham para lados
   * opostos: aqui é o cliente da loja pedindo um Pix; abaixo é o gateway
   * avisando que ele foi pago.
   *
   * A diferença que importa: estas não conferem assinatura, porque não há o que
   * conferir — quem chama é um navegador anônimo. O que as protege é não
   * aceitar valor de fora e não devolver nada que já não esteja no cardápio.
   */
  if (qual === "checkout") {
    return await lerCheckout(client, url.searchParams.get("org") ?? "", corsHeaders);
  }

  if (qual === "cobrar") {
    const corpo = await req.json().catch(() => ({}));

    return await criarCobranca(
      client,
      corpo,
      // De onde o gateway deve avisar de volta: esta mesma função, rota do
      // adaptador. Montado a partir da requisição para não haver uma URL de
      // produção escrita à mão que fica errada no ambiente de teste.
      `${url.origin}${url.pathname.replace(/\/[^/]*$/, "")}`,
      corsHeaders,
    );
  }

  /**
   * "Testar integração": as chaves funcionam?
   *
   * Esta é a única rota daqui que exige LOGIN, e a razão é simples: as três do
   * checkout são para o cliente da loja, e esta é para o dono dela. Ela lê o
   * segredo guardado e fala com o gateway usando o dinheiro dele.
   *
   * A permissão não é conferida com uma regra nova. O cliente é montado com o
   * token de quem chamou e tenta LER a linha de credencial: se a política de
   * RLS deixar — e ela só deixa admin da organização —, é admin. Inventar aqui
   * uma segunda definição de "quem pode" seria dois lugares decidindo o mesmo,
   * e um dia eles discordariam. - 2026/08/20
   */
  if (qual === "testar") {
    const { org } = await req.json().catch(() => ({}));

    if (!org) {
      return new Response(JSON.stringify({ erro: "faltou a organização" }), {
        status: 400,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    const comoUsuario = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      },
    );

    const { data: permitido } = await comoUsuario
      .from("gateway_credenciais")
      .select("organization_id")
      .eq("organization_id", org)
      .maybeSingle();

    if (!permitido) {
      return new Response(JSON.stringify({ erro: "sem permissão" }), {
        status: 403,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    const { data: credencial } = await client
      .from("gateway_credenciais")
      .select("provedor, chave_publica, chave_secreta")
      .eq("organization_id", org)
      .maybeSingle();

    if (!credencial) {
      return new Response(JSON.stringify({ erro: "nenhuma chave cadastrada" }), {
        status: 404,
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }

    try {
      const conferida = await testarAmploPay({
        publica: credencial.chave_publica ?? "",
        secreta: credencial.chave_secreta,
      });

      return new Response(JSON.stringify({ ok: true, ...conferida }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    } catch (erro) {
      /* 200 com `ok: false`, e não um código de erro: quem falhou foi o
       * gateway, não este pedido. A tela precisa da MENSAGEM para mostrar, e um
       * 4xx faria o cliente de consultas tratar como falha de rede e esconder
       * justamente o que a pessoa precisa ler. */
      const detalhe = erro instanceof ErroDoGateway
        ? { codigo: erro.codigo, mensagem: erro.message }
        : { mensagem: String(erro) };

      return new Response(JSON.stringify({ ok: false, ...detalhe }), {
        headers: { ...corsHeaders, "content-type": "application/json" },
      });
    }
  }

  if (qual === "situacao") {
    return await lerSituacao(
      client,
      url.searchParams.get("cobranca") ?? "",
      corsHeaders,
    );
  }

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
