import type { createClient } from "../_shared/supabase.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { connectWhatsAppNumber } from "./manual_signup.ts";
import * as log from "../_shared/logger.ts";

/**
 * # Entregar o número comprado na loja
 *
 * O pedido já está pago — o webhook da AmploPay confirmou isso e marcou
 * `loja_pedidos.status = 'pago'` via `quitar_pedido_loja`, do lado de
 * `pagamentos`. O que falta é o trabalho de verdade: ligar o número à
 * organização compradora na Graph API, exatamente como o fluxo manual já
 * faz — mesmo `debug_token`, mesma checagem de que o número pertence à WABA,
 * mesma assinatura de webhooks —, só que com um token que já está no cofre
 * desde que este número entrou no estoque (`set_loja_numero_token`, chamado
 * no cadastro), em vez de alguém colar um na tela.
 *
 * Por isso reaproveita `connectWhatsAppNumber` (extraído de
 * `performManualSignup` para exatamente este fim) em vez de duplicar os
 * passos da Graph API: um número comprado que "conecta" mas nunca recebe
 * mensagem é o mesmo bug de sempre que este arquivo evita, só que agora
 * vendido por dinheiro e sem ninguém, do lado do cliente, para quem
 * reclamar.
 *
 * ## Por que confere `status = 'pago'` de novo
 *
 * A rota que chama isto (`POST /whatsapp-management/loja/entregar`) já está
 * atrás de `requirePlatformAdmin`, mas isso só prova QUEM está clicando, não
 * EM QUE ESTADO está o pedido. Clicar "Conectar" duas vezes, ou clicar num
 * pedido que a tela ainda mostra como aberto porque não recarregou, não pode
 * religar um número já entregue nem tentar entregar um que ninguém pagou.
 *
 * ## O que ela não faz
 *
 * Não tem try/catch. Quem decide o que gravar em `logs` e com qual
 * `organization_id` é a rota em `index.ts` — do mesmo jeito que
 * `performManualSignup` não se preocupa com isso e a rota `/signup/manual`
 * cuida. A função fica só com o caminho feliz. - 2026/08/26
 */

export type LojaDeliveryPayload = {
  pedido_id: string;
  /**
   * Quem clicou "Conectar", para `loja_pedidos.conectado_por`. Não vai para
   * `organizations_addresses`: o número fica ligado à organização
   * compradora, não ao operador da plataforma que apertou o botão — a mesma
   * distinção entre "quem paga" e "quem processa o pagamento" que já existe
   * em qualquer outra parte deste produto.
   */
  admin_user_id?: string;
};

export async function performLojaDelivery(
  client: ReturnType<typeof createClient>,
  payload: LojaDeliveryPayload,
) {
  if (!payload.pedido_id) {
    throw new HTTPException(400, {
      message: "Missing 'pedido_id' body param!",
    });
  }

  const { data: pedido, error: pedidoError } = await client
    .from("loja_pedidos")
    .select("id, organization_id, numero_id, status")
    .eq("id", payload.pedido_id)
    .maybeSingle();

  if (pedidoError || !pedido) {
    throw new HTTPException(404, { message: "Pedido não encontrado." });
  }

  if (pedido.status !== "pago") {
    throw new HTTPException(409, {
      message: `Pedido está '${pedido.status}', esperava 'pago'.`,
    });
  }

  const { data: numero, error: numeroError } = await client
    .from("loja_numeros")
    .select("id, phone_number_id, waba_id, business_id, status")
    .eq("id", pedido.numero_id)
    .maybeSingle();

  if (numeroError || !numero) {
    throw new HTTPException(404, { message: "Número não encontrado." });
  }

  const ctx = {
    pedido_id: pedido.id,
    organization_id: pedido.organization_id,
    numero_id: numero.id,
  };

  log.info("Loja delivery: reading the stored token", ctx);
  const { data: token, error: tokenError } = await client.rpc(
    "get_loja_numero_token",
    { p_numero_id: numero.id },
  );

  if (tokenError || !token) {
    throw new HTTPException(500, {
      message: "Token do número não encontrado no cofre.",
      cause: tokenError,
    });
  }

  const address = await connectWhatsAppNumber(client, token, {
    organization_id: pedido.organization_id,
    phone_number_id: numero.phone_number_id,
    waba_id: numero.waba_id,
    business_id: numero.business_id ?? undefined,
    flow_type: "loja",
  });

  log.info(
    "Loja delivery: marking the number sold and the order delivered",
    ctx,
  );

  await client
    .from("loja_numeros")
    .update({ status: "conectado" })
    .eq("id", numero.id)
    .throwOnError();

  await client
    .from("loja_pedidos")
    .update({
      status: "conectado",
      conectado_em: new Date().toISOString(),
      conectado_por: payload.admin_user_id ?? null,
    })
    .eq("id", pedido.id)
    .throwOnError();

  log.info("Loja delivery completed", { ...ctx, address: address.address });

  return address;
}
