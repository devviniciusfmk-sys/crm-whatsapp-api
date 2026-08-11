import * as webpush from "@negrel/webpush";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * # Puxar quem cuida da loja, quando ele não está olhando a tela
 *
 * A reclamação já chega vermelha na lista desde 2026/08/09. Vermelho só serve
 * para quem está olhando, e numa barbearia ninguém está: o dono está de tesoura
 * na mão e a tela fica apagada no fundo da loja. Medido em 2026/08/10, num dia
 * de movimento simulado, 6 das 30 conversas eram reclamações — todas marcadas
 * certo, e nenhuma teria chamado ninguém.
 *
 * ## Por que push do navegador, e não WhatsApp
 *
 * Avisar pelo WhatsApp do dono seria chegar onde ele já está o dia todo — e
 * custa: a Meta não deixa iniciar conversa com texto livre, então cada aviso é
 * um template aprovado e pago. Enquanto a cobrança não existe, um aviso que
 * cobra por reclamação é um aviso que alguém desliga. O push do navegador é
 * gratuito, chega com o navegador fechado (no computador e no Android) e não
 * depende de aprovação de ninguém.
 *
 * **Limite conhecido, e vale dizer em voz alta:** no iPhone só funciona se a
 * pessoa tiver adicionado o sistema à tela de início. É restrição do iOS, não
 * escolha nossa, e não há contorno — a alternativa naquele aparelho é o
 * WhatsApp, que fica para quando houver cobrança.
 *
 * ## Nunca no caminho da resposta
 *
 * Todo envio daqui é `void`, e cada falha vira aviso no log e nada mais. Um
 * serviço de push fora do ar não pode atrasar nem derrubar a resposta ao
 * cliente: quem está esperando é ele, e o aviso é para depois. - 2026/08/10
 */

export type MotivoDoAviso =
  | "complaint"
  | "wants_person"
  | "cannot_resolve"
  | "silence"
  | "stale";

/**
 * O que cada motivo diz na tela do aparelho.
 *
 * Em português porque é o idioma de quem opera hoje, e a tela também está em
 * português. Quando houver o segundo país, isto sai daqui para o idioma da
 * organização — não do contato, que fala outro.
 */
const TEXTOS: Record<MotivoDoAviso, { titulo: string; corpo: string }> = {
  complaint: {
    titulo: "Reclamação de um cliente",
    corpo: "Alguém está reclamando e precisa de uma pessoa.",
  },
  wants_person: {
    titulo: "Cliente pediu falar com alguém",
    corpo: "Pediu uma pessoa, sem ter reclamado de nada.",
  },
  cannot_resolve: {
    titulo: "O assistente não resolveu",
    corpo: "Uma conversa está esperando alguém da equipe.",
  },
  silence: {
    titulo: "Cliente sem resposta",
    corpo: "O assistente não conseguiu responder. Ninguém falou com ele.",
  },
  stale: {
    titulo: "Ninguém assumiu ainda",
    corpo: "Uma conversa espera há um tempo e continua sem dono.",
  },
};

let servidor: webpush.ApplicationServer | null = null;

/**
 * O servidor de aplicação, montado uma vez por instância.
 *
 * Importar as chaves custa uma operação de cripto, e refazê-la a cada aviso
 * seria pagar por nada num caminho que já é secundário.
 */
async function servidorDeAviso(): Promise<webpush.ApplicationServer | null> {
  if (servidor) return servidor;

  const chaves = Deno.env.get("VAPID_KEYS");

  if (!chaves) return null;

  servidor = await webpush.ApplicationServer.new({
    contactInformation: `mailto:${
      Deno.env.get("VAPID_CONTACT") ?? "suporte@openbsp.app"
    }`,
    vapidKeys: await webpush.importVapidKeys(JSON.parse(chaves), {
      extractable: false,
    }),
  });

  return servidor;
}

/**
 * Avisa todo mundo que pediu para ser avisado nesta organização.
 *
 * Não espera o resultado de propósito: quem chama está no meio de responder a
 * um cliente. Devolve uma promessa só para quem quiser aguardar em teste.
 */
export async function avisarAEquipe(
  client: SupabaseClient,
  organizationId: string,
  motivo: MotivoDoAviso,
  detalhe: { conversationId: string; contato?: string | null },
): Promise<{ enviados: number; falhas: string[] }> {
  const app = await servidorDeAviso();

  if (!app) return { enviados: 0, falhas: ["sem VAPID_KEYS configurada"] };

  const { data: inscricoes } = await client
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("organization_id", organizationId);

  if (!inscricoes?.length) return { enviados: 0, falhas: [] };

  const texto = TEXTOS[motivo];

  const carga = JSON.stringify({
    title: texto.titulo,
    body: detalhe.contato ? `${detalhe.contato}: ${texto.corpo}` : texto.corpo,
    motivo,
    // Para o clique abrir a conversa certa, e não a lista.
    conversationId: detalhe.conversationId,
  });

  let enviados = 0;

  // Devolvidas a quem chamou: sem elas, "enviados: 0" é um número sem motivo,
  // e foi exatamente assim que este defeito ficou opaco. - 2026/08/11
  const falhas: string[] = [];

  await Promise.all(inscricoes.map(async (inscricao) => {
    try {
      const assinante = app.subscribe({
        endpoint: inscricao.endpoint as string,
        keys: {
          p256dh: inscricao.p256dh as string,
          auth: inscricao.auth as string,
        },
      });

      await assinante.pushTextMessage(carga, {
        // Urgência alta: uma reclamação não espera o aparelho acordar sozinho.
        urgency: webpush.Urgency.High,
        ttl: 60 * 60,
      });

      enviados++;
    } catch (erro) {
      /**
       * A inscrição morta se apaga aqui, e não numa faxina que ninguém roda.
       *
       * O navegador troca as chaves sozinho e a pessoa limpa os dados; o
       * endpoint antigo passa a responder 404/410 para sempre. Sem apagar, cada
       * aviso futuro carrega a tentativa morta junto, e quem lê a tabela não
       * distingue quem está inscrito de quem esteve.
       */
      const status = erro instanceof webpush.PushMessageError
        ? erro.response.status
        : 0;

      /**
       * O motivo sai SEMPRE, inclusive quando a inscrição é apagada.
       *
       * A primeira versão registrava só as falhas que NÃO eram 404/410 — as
       * outras sumiam caladas, porque "inscrição morta" parecia rotina. Medido
       * em 2026/08/11: o teste do aviso caiu de 4/4 para 2/4 e a única pista
       * era "enviados: 0", com a linha desaparecendo do banco. Um caminho que
       * APAGA dado tem de dizer por quê, ainda mais quando apagar é o normal
       * dele.
       */
      console.warn("aviso não entregue", {
        organization_id: organizationId,
        motivo,
        status,
        erro: erro instanceof Error ? erro.message : String(erro),
      });

      falhas.push(
        `${status || "?"}: ${
          (erro instanceof Error ? erro.message : String(erro)).slice(0, 120)
        }`,
      );

      if (status === 404 || status === 410) {
        await client
          .from("push_subscriptions")
          .delete()
          .eq("id", inscricao.id);
      }
    }
  }));

  return { enviados, falhas };
}
