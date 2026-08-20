import type { SupabaseClient } from "@supabase/supabase-js";
import { criarPixAmploPay, ErroDoGateway } from "./criar.ts";

/**
 * # O checkout, do lado de fora
 *
 * Três rotas que qualquer pessoa alcança sem login, porque quem as usa é o
 * cliente da loja — alguém que recebeu um link no WhatsApp e não tem conta
 * aqui, nem deveria precisar de uma para pagar um corte de cabelo.
 *
 *   GET  /pagamentos/checkout?org=…     o que a loja vende
 *   POST /pagamentos/cobrar             cria a cobrança e devolve o Pix
 *   GET  /pagamentos/situacao?cobranca= já pagou?
 *
 * ## A regra que segura tudo: o preço é nosso
 *
 * A página manda QUAIS itens, e nunca QUANTO. O valor sai do catálogo, aqui
 * dentro, na hora. Uma página é código que roda na máquina de outra pessoa —
 * qualquer um abre o console e troca 17 por 1 —, e um valor vindo de lá seria
 * o cliente dizendo quanto quer pagar.
 *
 * É a mesma razão de a validade também sair daqui: quem escolhe por quantos
 * dias o plano vale é quem o vende.
 *
 * ## O que estas rotas não expõem
 *
 * A leitura só devolve nome da loja e catálogo com preço — o que já está no
 * cardápio da parede. Nunca a chave Pix, nunca as credenciais do gateway,
 * nunca conversas ou outros clientes. É por isso que elas montam a resposta
 * campo a campo em vez de repassar a linha do banco: um `select *` que um dia
 * ganhe uma coluna nova a publica sem ninguém perceber. - 2026/08/19
 */

/* O cliente entra por parâmetro em vez de ser criado aqui: é o que permite
 * testar estas rotas sem banco, e o que impede este arquivo de decidir com
 * qual permissão fala. Quem chama é que sabe. */
type Cliente = SupabaseClient;

const json = (corpo: unknown, status = 200, cors: HeadersInit = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

/** Um serviço do catálogo, como a tela de configurações o grava. */
type Servico = {
  name: string;
  price?: number;
  minutes?: number;
  validade_dias?: number;
};

function catalogoDe(extra: unknown): Servico[] {
  const servicos = (extra as { appointments?: { services?: Servico[] } })
    ?.appointments?.services ?? [];

  /* Sem preço não dá para vender pela internet: o checkout não tem ninguém do
   * outro lado para combinar quanto é. Na conversa isso funciona, porque tem. */
  return servicos.filter((s) => typeof s?.price === "number" && s.price > 0);
}

/** O que a loja vende, para a página montar a lista de planos. */
export async function lerCheckout(
  cliente: Cliente,
  org: string,
  cors: HeadersInit,
) {
  if (!org) return json({ erro: "faltou a organização" }, 400, cors);

  const { data: loja } = await cliente
    .from("organizations")
    .select("id, name, extra")
    .eq("id", org)
    .single();

  if (!loja) return json({ erro: "loja não encontrada" }, 404, cors);

  const { data: credencial } = await cliente
    .from("gateway_credenciais")
    .select("organization_id, ativo")
    .eq("organization_id", org)
    .maybeSingle();

  return json({
    loja: loja.name,
    /* Campo a campo, de propósito. Repassar `extra` inteiro entregaria a chave
     * Pix, os horários, o modelo de mensagem e o que mais entrar lá depois. */
    planos: catalogoDe(loja.extra).map((s) => ({
      nome: s.name,
      preco: s.price,
      validade_dias: s.validade_dias ?? null,
    })),
    /* A página precisa saber para não oferecer um botão que não funciona. Um
     * booleano, e não a chave pública: ela não tem uso do lado de fora. */
    gateway: Boolean(credencial?.ativo),
  }, 200, cors);
}

/**
 * Cria a cobrança e devolve o Pix.
 *
 * ## Por que abre uma conversa
 *
 * A confirmação de pagamento sai pelo WhatsApp, e para sair precisa de uma
 * conversa. Sem isso o cliente paga e não recebe nada — que é justamente o
 * problema que este produto existe para resolver.
 *
 * De quebra, a loja ganha o cliente no CRM em vez de um pagamento anônimo no
 * extrato. Um pedido que vira conversa é um cliente que dá para chamar de
 * volta no mês que vem.
 */
export async function criarCobranca(
  cliente: Cliente,
  corpo: {
    org?: string;
    itens?: string[];
    nome?: string;
    telefone?: string;
    documento?: string;
  },
  urlDaFuncao: string,
  cors: HeadersInit,
) {
  const { org, itens = [], nome, telefone } = corpo;

  if (!org || !itens.length || !telefone) {
    return json({ erro: "faltou organização, itens ou telefone" }, 400, cors);
  }

  const fone = String(telefone).replace(/\D/g, "");

  if (fone.length < 10) return json({ erro: "telefone inválido" }, 400, cors);

  const { data: loja } = await cliente
    .from("organizations")
    .select("id, name, extra")
    .eq("id", org)
    .single();

  if (!loja) return json({ erro: "loja não encontrada" }, 404, cors);

  /* O preço sai DAQUI. A página escolhe o quê; o quanto é nosso. */
  const catalogo = catalogoDe(loja.extra);
  const escolhidos = itens
    .map((n) => catalogo.find((s) => s.name === n))
    .filter(Boolean) as Servico[];

  if (escolhidos.length !== itens.length) {
    /* Um item que não está no catálogo não é um erro de digitação do cliente —
     * a página só oferece o que veio da leitura. É alguém montando o pedido na
     * mão, e a resposta certa é não criar cobrança nenhuma. */
    return json({ erro: "item fora do catálogo" }, 400, cors);
  }

  const valor = escolhidos.reduce((t, s) => t + (s.price ?? 0), 0);

  /* A maior validade entre os itens, e não a soma: quem compra plano anual mais
   * uma instalação avulsa comprou um ano, não um ano e um dia. */
  const validade = escolhidos
    .map((s) => s.validade_dias)
    .filter((d): d is number => typeof d === "number")
    .reduce((maior, d) => Math.max(maior, d), 0);

  const { data: credencial } = await cliente
    .from("gateway_credenciais")
    .select("chave_publica, chave_secreta, ativo")
    .eq("organization_id", org)
    .maybeSingle();

  if (!credencial?.ativo) {
    return json({ erro: "esta loja não tem gateway configurado" }, 409, cors);
  }

  /* --- a conversa ---------------------------------------------------------- */

  const { data: endereco } = await cliente
    .from("organizations_addresses")
    .select("address, service")
    .eq("organization_id", org)
    .eq("service", "whatsapp")
    .maybeSingle();

  if (!endereco) {
    return json({ erro: "esta loja não tem WhatsApp ligado" }, 409, cors);
  }

  const { data: existente } = await cliente
    .from("conversations")
    .select("id, name")
    .eq("organization_id", org)
    .eq("contact_address", fone)
    .eq("service", "whatsapp")
    .maybeSingle();

  let conversa = existente?.id as string | undefined;

  if (!conversa) {
    const { data: nova, error } = await cliente
      .from("conversations")
      .insert({
        organization_id: org,
        organization_address: endereco.address,
        contact_address: fone,
        service: "whatsapp",
        name: nome || null,
      })
      .select("id")
      .single();

    if (error) return json({ erro: error.message }, 500, cors);

    conversa = nova.id;
  }

  /* --- a cobrança ---------------------------------------------------------- */

  const { data: cobranca, error: erroCobranca } = await cliente
    .from("cobrancas")
    .insert({
      organization_id: org,
      conversation_id: conversa,
      contact_address: fone,
      itens: escolhidos.map((s) => ({ nome: s.name, valor: s.price })),
      valor,
      status: "aberta",
      metodo: "amplopay",
      validade_dias: validade || null,
    })
    .select("id")
    .single();

  if (erroCobranca) return json({ erro: erroCobranca.message }, 500, cors);

  /* --- o gateway ----------------------------------------------------------- */

  try {
    const criada = await criarPixAmploPay({
      /* O prefixo `cob:` é o que diz, na volta, que este dinheiro é de um
       * cliente da loja e não da mensalidade que a loja paga. */
      referencia: `cob:${cobranca.id}`,
      valor,
      pagador: {
        nome: nome || "Cliente",
        /* Um endereço que nenhum servidor entrega, porque o cliente não deu
         * e-mail e a AmploPay exige um. Domínio reservado pela RFC 2606 para
         * exatamente isto — inventar um `@gmail.com` mandaria a confirmação
         * do gateway para uma pessoa de verdade que não comprou nada. */
        email: `${fone}@example.invalid`,
        telefone: fone,
        documento: corpo.documento,
      },
      itens: escolhidos.map((s) => ({ nome: s.name, valor: s.price ?? 0 })),
      avisarEm: `${urlDaFuncao}/amplopay`,
    }, {
      publica: credencial.chave_publica,
      secreta: credencial.chave_secreta,
    });

    await cliente
      .from("cobrancas")
      .update({ codigo_pix: criada.codigo, external_id: criada.transacao })
      .eq("id", cobranca.id);

    return json({
      cobranca: cobranca.id,
      codigo: criada.codigo,
      imagem: criada.imagem ?? null,
      valor,
      itens: escolhidos.map((s) => ({ nome: s.name, valor: s.price })),
    }, 201, cors);
  } catch (erro) {
    /* A cobrança fica aberta e sem código, que é o estado honesto: o pedido
     * existiu, o Pix não. Apagá-la esconderia do dono da loja que alguém tentou
     * comprar e não conseguiu — e é isso que ele precisa ver para saber que o
     * gateway está com problema. */
    const detalhe = erro instanceof ErroDoGateway
      ? { codigo: erro.codigo, campo: erro.campo, mensagem: erro.message }
      : { mensagem: String(erro) };

    console.error("[checkout] o gateway recusou", detalhe);

    return json({ erro: "não consegui gerar o Pix", ...detalhe }, 502, cors);
  }
}

/**
 * Já pagou?
 *
 * A página pergunta de tempos em tempos enquanto o cliente está no aplicativo
 * do banco. Quem responde de verdade é o postback — este endereço só olha o
 * que ele já escreveu.
 */
export async function lerSituacao(
  cliente: Cliente,
  cobrancaId: string,
  cors: HeadersInit,
) {
  if (!cobrancaId) return json({ erro: "faltou a cobrança" }, 400, cors);

  const { data } = await cliente
    .from("cobrancas")
    .select("id, status, valor, itens, vence_em, paga_em, codigo_pix")
    .eq("id", cobrancaId)
    .maybeSingle();

  if (!data) return json({ erro: "cobrança não encontrada" }, 404, cors);

  /* Só o que a página precisa desenhar. `organization_id` e `contact_address`
   * ficam de fora: quem tem o id de uma cobrança não deveria conseguir mapear
   * a loja e o telefone de quem comprou. */
  return json({
    status: data.status,
    valor: data.valor,
    itens: data.itens,
    vence_em: data.vence_em,
    paga_em: data.paga_em,
    codigo: data.codigo_pix,
  }, 200, cors);
}
