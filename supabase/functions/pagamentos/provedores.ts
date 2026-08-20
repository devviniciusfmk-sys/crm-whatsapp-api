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
 * `billing.registrar_pagamento` e `public.quitar_cobranca`, que já tratam
 * postback reenviado. Adaptador que decide vira quatro lugares decidindo a
 * mesma coisa de quatro jeitos. - 2026/08/19
 */

/** O que qualquer gateway precisa dizer, traduzido para o nosso vocabulário. */
export type Aviso = {
  /** A cobrança que está sendo paga: a referência que mandamos na criação. */
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
   * Sem isto, qualquer um que descubra a URL marca cobranças como pagas — e a
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

/** Um número que veio como "97,50", "97.50" ou 97.5. */
function comoNumero(valor: unknown): number {
  if (typeof valor === "number") return valor;

  const n = Number(String(valor ?? "").replace(/[^\d,.-]/g, "").replace(",", "."));

  return Number.isFinite(n) ? n : 0;
}

/**
 * Os cinco eventos que a AmploPay dispara. Não há um sexto — a documentação
 * lista o conjunto inteiro, e evento fora desta lista cai em "pendente", que é
 * a resposta segura: não fecha nada.
 */
const POR_EVENTO: Record<string, Aviso["situacao"]> = {
  TRANSACTION_CREATED: "pendente",
  TRANSACTION_PAID: "pago",
  TRANSACTION_CANCELED: "recusado",
  TRANSACTION_REFUNDED: "estornado",
  TRANSACTION_CHARGED_BACK: "estornado",
};

/** E os cinco status, para quando o aviso vier sem `event`. */
const POR_STATUS: Record<string, Aviso["situacao"]> = {
  PENDING: "pendente",
  COMPLETED: "pago",
  FAILED: "recusado",
  REFUNDED: "estornado",
  CHARGED_BACK: "estornado",
};

/**
 * # AmploPay
 *
 * Lido da documentação deles em 2026/08/19 (`app.amplopay.com/docs`), que é
 * pública mas só abre com identificação de navegador — `curl` comum leva 403.
 *
 *   base   https://app.amplopay.com/api/v1
 *   auth   headers `x-public-key` e `x-secret-key`
 *   criar  POST /gateway/pix/receive
 *
 * ## Três coisas que eu tinha chutado errado antes de ler
 *
 * 1. O valor é em REAIS, e não em centavos. O palpite de centavos cobraria
 *    cem vezes menos — R$ 0,97 no lugar de R$ 97,00.
 * 2. A autenticidade do postback vem num campo `token` DO CORPO, e não num
 *    cabeçalho de assinatura. Procurar só no cabeçalho recusaria todo aviso
 *    legítimo.
 * 3. A referência que mandamos na criação chama-se `identifier`, e não
 *    `external_reference`. Sem o nome certo, nenhum pagamento acharia a
 *    cobrança dele.
 *
 * ## A referência muda de nome no caminho
 *
 * Mandamos `identifier` na criação e ele volta chamado `clientIdentifier` —
 * na consulta de transação e no postback. Não é um apelido nosso: é o nome
 * documentado do campo na resposta. Ler `identifier` na volta acha nada, e uma
 * cobrança sem referência é uma cobrança que nunca fecha sozinha.
 */
export const amplopay: Adaptador = {
  nome: "amplopay",

  confere: (req, corpo, segredo) => {
    if (!segredo) return false;

    /* O token do corpo é o jeito deles. O cabeçalho fica aceito também porque
     * é o que a maioria dos gateways faz — e porque é assim que o nosso teste
     * de ponta a ponta chama, sem precisar de um corpo válido para provar que
     * a recusa funciona. */
    let doCorpo: unknown;

    try {
      doCorpo = (JSON.parse(corpo) as { token?: unknown })?.token;
    } catch {
      doCorpo = undefined;
    }

    const doCabecalho = req.headers.get("x-webhook-secret") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      new URL(req.url).searchParams.get("token");

    return doCorpo === segredo || doCabecalho === segredo;
  },

  ler: (corpo) => {
    const c = corpo as Record<string, unknown>;
    const t = (c?.transaction ?? {}) as Record<string, unknown>;

    /* `clientIdentifier` é como o `identifier` que mandamos na criação volta.
     * Os outros nomes ficam como rede, caso um evento chegue por outra rota. */
    const fatura = String(
      t.clientIdentifier ?? c.clientIdentifier ?? t.identifier ?? c.identifier ??
        "",
    );

    const transacao = String(
      t.id ?? t.transactionId ?? c.transactionId ?? c.id ?? "",
    );

    if (!fatura || !transacao) return null;

    /**
     * O EVENTO manda, e o status é a segunda opinião.
     *
     * As duas listas são fechadas e documentadas, então são tabelas e não
     * expressões regulares. `/cancel/` solto casaria com
     * "cancellation_requested", que ainda não cancelou nada.
     *
     * `TRANSACTION_CREATED` é o que mais engana: chega no instante em que a
     * cobrança nasce, antes de qualquer pagamento. Tratá-lo como pago quitaria
     * toda cobrança no momento em que fosse criada.
     */
    const evento = String(c.event ?? "").toUpperCase();
    const bruto = String(t.status ?? c.status ?? "").toUpperCase();

    const situacao = POR_EVENTO[evento] ?? POR_STATUS[bruto] ?? "pendente";

    return {
      fatura,
      transacao,
      /* Em reais, e `amount` é o que a loja recebe. `chargeAmount` é o que o
       * cliente pagou, e os dois diferem quando há taxa de parcelamento — mas
       * quem quita a fatura é o que entrou. */
      valor: comoNumero(t.amount ?? c.amount),
      situacao,
    };
  },
};

export const ADAPTADORES: Record<string, Adaptador> = {
  amplopay,
};
