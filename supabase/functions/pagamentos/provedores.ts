/**
 * # A porta por onde os gateways entram
 *
 * Cada gateway avisa um pagamento do seu jeito: nomes de campo diferentes,
 * status escritos de outro modo, assinatura conferida de outra forma. Isso é
 * problema deles, e este arquivo existe para que continue sendo.
 *
 * Um adaptador por provedor, cada um respondendo a mesma pergunta — "isto é um
 * pagamento aprovado, de qual cobrança, de quanto?" — e nada mais. O resto do
 * sistema não sabe que a AmploPay existe, e no dia em que ela for trocada, um
 * arquivo sai e outro entra.
 *
 * ## Por que a referência é o id da fatura
 *
 * Quando a cobrança é criada no gateway, mandamos junto uma referência nossa.
 * Ela volta no postback e é o único fio que liga "caiu R$ 97" a "esta loja,
 * esta fatura". Sem ela seria preciso adivinhar por valor e horário — e duas
 * lojas cobrando R$ 97 no mesmo minuto quebram esse palpite.
 *
 * ## O que NÃO mora aqui
 *
 * Decidir se quita, se é repetido, se o valor bate. Isso é do banco, em
 * `billing.registrar_pagamento`, que já trata postback reenviado devolvendo o
 * mesmo pagamento em vez de criar o segundo. Adaptador que decide vira quatro
 * lugares decidindo a mesma coisa de quatro jeitos. - 2026/08/19
 */

/** O que qualquer gateway precisa dizer, traduzido para o nosso vocabulário. */
export type Aviso = {
  /** A fatura que está sendo paga: a referência que mandamos na criação. */
  fatura: string;
  /** O identificador da transação no gateway. É a trava contra repetido. */
  transacao: string;
  /** Em reais. */
  valor: number;
  /**
   * Só "pago" faz alguma coisa. Os outros existem para o adaptador poder
   * dizer "li e não é pagamento", que é diferente de "não entendi".
   */
  situacao: "pago" | "pendente" | "recusado" | "estornado";
};

export type Adaptador = {
  nome: string;
  /**
   * Confere que o postback veio mesmo do gateway.
   *
   * Sem isto, qualquer um que descubra a URL marca faturas como pagas — e a
   * URL de webhook não é segredo: ela vai no painel do gateway, em prints, em
   * conversa de suporte. Cada provedor assina do seu jeito; o adaptador sabe
   * qual é o dele.
   */
  confere: (req: Request, corpo: string, segredo: string) => boolean;
  /**
   * Traduz o corpo. `null` quando não é um evento que nos interessa — e isso
   * NÃO é erro: gateways mandam eventos de tudo, e responder 200 para o que
   * não interessa evita que eles fiquem reenviando para sempre.
   */
  ler: (corpo: unknown) => Aviso | null;
};

/** Um número que veio como "97,50", "97.50" ou 9750 (centavos). */
function comoNumero(valor: unknown, emCentavos = false): number {
  if (typeof valor === "number") return emCentavos ? valor / 100 : valor;

  const limpo = String(valor ?? "").replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = Number(limpo);

  if (!Number.isFinite(n)) return 0;

  return emCentavos ? n / 100 : n;
}

/**
 * O adaptador da AmploPay.
 *
 * A documentação deles é privada — `docs.amplopay.com.br` não existe e
 * `app.amplopay.com` responde 403 —, então os nomes de campo abaixo são os do
 * formato mais comum entre gateways brasileiros, com alternativas aceitas. Não
 * são um palpite escondido: `ler` devolve `null` quando não encontra o que
 * precisa, e um postback real que não casar aparece no log em vez de virar
 * pagamento errado.
 *
 * Para fechar isto de vez basta UM postback de venda aprovada, copiado do
 * painel. Cinco minutos de trabalho depois disso. - 2026/08/19
 */
export const amplopay: Adaptador = {
  nome: "amplopay",

  confere: (req, _corpo, segredo) => {
    // Enquanto o esquema de assinatura deles não for conhecido, a defesa é um
    // segredo combinado no cabeçalho. É o mínimo que impede alguém que
    // descobriu a URL de marcar faturas como pagas.
    const enviado = req.headers.get("x-webhook-secret") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      new URL(req.url).searchParams.get("token");

    return !!segredo && enviado === segredo;
  },

  ler: (corpo) => {
    const c = corpo as Record<string, unknown>;
    const dados = (c?.data ?? c?.transaction ?? c) as Record<string, unknown>;

    const fatura = String(
      dados?.external_reference ?? dados?.reference ?? dados?.reference_id ??
        dados?.external_id ?? "",
    );

    const transacao = String(dados?.id ?? dados?.transaction_id ?? "");

    if (!fatura || !transacao) return null;

    const bruto = String(dados?.status ?? c?.status ?? "").toLowerCase();

    const situacao: Aviso["situacao"] = /paid|approved|aprovad|pago|success/
        .test(bruto)
      ? "pago"
      : /refund|estorn|charge_?back/.test(bruto)
      ? "estornado"
      : /refus|denied|cancel|fail|recusad/.test(bruto)
      ? "recusado"
      : "pendente";

    /* Centavos quando o campo se chama `amount` — é a convenção da maioria —,
     * e reais quando vem `value`. Errar aqui é cobrar cem vezes mais ou cem
     * vezes menos, então o registro guarda o valor e o confronto com o total
     * da fatura acontece no banco. */
    const valor = dados?.amount !== undefined
      ? comoNumero(dados.amount, true)
      : comoNumero(dados?.value ?? dados?.valor);

    return { fatura, transacao, valor, situacao };
  },
};

export const ADAPTADORES: Record<string, Adaptador> = {
  amplopay,
};
