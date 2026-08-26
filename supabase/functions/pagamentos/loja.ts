import type { SupabaseClient } from "@supabase/supabase-js";
import { criarPixAmploPay, ErroDoGateway } from "./criar.ts";

/**
 * # A compra de um número da loja
 *
 * Espelha `criarCobranca` em `checkout.ts`, com uma diferença de fundo: ali
 * quem compra é um cliente anônimo da loja de uma organização; aqui quem
 * compra é a PRÓPRIA organização, autenticada, comprando da plataforma. O
 * dinheiro muda de dono, mas a disciplina é a mesma — preço e valor nunca vêm
 * do corpo da requisição, e o pedido fica registrado mesmo quando o gateway
 * falha.
 *
 * ## Por que a reserva é uma função do banco, e não um `select` + `insert`
 * aqui
 *
 * Dois operadores clicando "comprar" no mesmo número ao mesmo tempo é uma
 * corrida de verdade, e resolvê-la aqui em cima — ler o status, checar se
 * está livre, inserir o pedido — teria uma janela entre o `select` e o
 * `insert` onde os dois passam. `reservar_numero_loja` decide isso dentro de
 * uma transação, atômica por construção, e levanta uma exceção com a frase
 * certa quando o número já não está livre. Essa frase é repassada direto:
 * "não consegui reservar" genérico esconderia justamente o motivo que quem
 * comprou precisa ler.
 */

type Cliente = SupabaseClient;

const json = (corpo: unknown, status = 200, cors: HeadersInit = {}) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

/**
 * AmploPay exige um telefone, mas quem compra na loja é uma organização
 * autenticada, não um contato de WhatsApp que deu o número dele numa
 * conversa. Não há coluna confiável para isso — nem em `organizations`
 * (não existe), nem no usuário (a maioria entra por e-mail/senha, sem
 * telefone cadastrado no Supabase Auth). A diferença que torna isso seguro
 * de improvisar: ao contrário da cobrança de cliente, NENHUMA mensagem de
 * confirmação depende deste número aqui — ele só preenche um campo que o
 * gateway insiste em receber. Por isso um placeholder fixo, em formato
 * válido, em vez de inventar um dado que pareceria real sem ser.
 */
const TELEFONE_PLACEHOLDER = "11999999999";

/**
 * Cria o pedido de compra de um número e devolve o Pix.
 *
 * `requester` já chega verificado — quem chamou (`index.ts`) confirmou o JWT
 * e que o usuário é owner da organização compradora antes de chegar aqui.
 * Esta função não reconfere nada disso; ela só confia no que recebeu, do
 * mesmo jeito que `criarCobranca` confia que quem a chamou já decidiu que a
 * requisição é legítima.
 */
export async function criarPedidoLoja(
  cliente: Cliente,
  corpo: { organization_id?: string; numero_id?: string },
  requester: { userId: string; email?: string | null },
  urlDaFuncao: string,
  cors: HeadersInit,
) {
  const { organization_id, numero_id } = corpo;

  if (!organization_id || !numero_id) {
    return json({ erro: "faltou organização ou número" }, 400, cors);
  }

  // Credenciais da PLATAFORMA, não de uma organização — por isso vêm de env
  // var e não de `gateway_credenciais`, que é por organização. Mesmo padrão
  // de operador único que `_shared/platform_admin.ts` usa para
  // `ADMIN_EMAILS`.
  const chavePublica = Deno.env.get("AMPLOPAY_LOJA_CHAVE_PUBLICA");
  const chaveSecreta = Deno.env.get("AMPLOPAY_LOJA_CHAVE_SECRETA");

  if (!chavePublica || !chaveSecreta) {
    return json(
      { erro: "a loja de números ainda não está configurada" },
      503,
      cors,
    );
  }

  /* --- a reserva ------------------------------------------------------- */

  const { data: pedido, error: erroReserva } = await cliente.rpc(
    "reservar_numero_loja",
    {
      _numero: numero_id,
      _organization_id: organization_id,
      _user_id: requester.userId,
    },
  ) as {
    data: { id: string; valor: number } | null;
    error: { message: string } | null;
  };

  if (erroReserva || !pedido) {
    return json(
      {
        erro: erroReserva?.message ?? "não foi possível reservar este número",
      },
      409,
      cors,
    );
  }

  /* --- quem compra ------------------------------------------------------- */

  const { data: org } = await cliente
    .from("organizations")
    .select("name")
    .eq("id", organization_id)
    .single();

  // Best-effort: só para deixar o Pix com uma descrição legível no app do
  // banco de quem compra. Falhar aqui não impede a compra.
  const { data: numero } = await cliente
    .from("loja_numeros")
    .select("phone_number, verified_name")
    .eq("id", numero_id)
    .maybeSingle();

  const descricaoNumero = numero?.phone_number
    ? `Número WhatsApp ${numero.phone_number}`
    : "Número WhatsApp";

  /* --- o gateway ----------------------------------------------------------- */

  try {
    const criada = await criarPixAmploPay({
      /* O prefixo `loja:` é o que diz, no postback, que este dinheiro é da
       * PLATAFORMA vendendo um número — não de um cliente pagando uma
       * organização (`cob:`) nem da mensalidade que a organização paga
       * (`fat:`). Ver o despacho em `pagamentos/index.ts`. */
      referencia: `loja:${pedido.id}`,
      valor: pedido.valor,
      pagador: {
        nome: org?.name || "Organização",
        /* E-mail de verdade quando existe: quem compra é autenticado, não
         * anônimo como em `criarCobranca`. O placeholder só cobre a borda de
         * um usuário sem e-mail (login só por telefone). */
        email: requester.email || `${requester.userId}@example.invalid`,
        telefone: TELEFONE_PLACEHOLDER,
      },
      itens: [{ nome: descricaoNumero, valor: pedido.valor }],
      avisarEm: `${urlDaFuncao}/amplopay`,
    }, { publica: chavePublica, secreta: chaveSecreta });

    await cliente
      .from("loja_pedidos")
      .update({ codigo_pix: criada.codigo, external_id: criada.transacao })
      .eq("id", pedido.id);

    return json(
      {
        pedido: pedido.id,
        codigo: criada.codigo,
        imagem: criada.imagem ?? null,
        valor: pedido.valor,
      },
      201,
      cors,
    );
  } catch (erro) {
    /* O pedido fica reservado e sem código, o estado honesto: a reserva
     * existiu, o Pix não. Mesma decisão de `criarCobranca` — apagar
     * esconderia do operador que uma compra quase aconteceu e travou no
     * gateway. */
    const detalhe = erro instanceof ErroDoGateway
      ? { codigo: erro.codigo, campo: erro.campo, mensagem: erro.message }
      : { mensagem: String(erro) };

    console.error("[loja] o gateway recusou", detalhe);

    return json({ erro: "não consegui gerar o Pix", ...detalhe }, 502, cors);
  }
}
