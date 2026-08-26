import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { avisarAEquipe, type MotivoDoAviso } from "../_shared/avisar.ts";

/**
 * # Avisar quem cuida da loja
 *
 * O envio em si mora em `_shared/avisar.ts`, porque o `agent-client` avisa
 * direto de dentro do seu próprio caminho — sem uma volta pela rede para falar
 * consigo mesmo. Esta função existe para os dois chamadores que NÃO são ele:
 *
 * - o cron do banco, quando uma conversa espera há tempo demais e ninguém
 *   assumiu (`escalate_stale_handoffs`);
 * - a tela, para mandar um aviso de teste na hora em que a pessoa liga a
 *   permissão. Sem isso ela liga, não vê nada, e não tem como saber se
 *   funcionou até acontecer uma reclamação de verdade — que é o pior momento
 *   possível para descobrir que não chega.
 *
 * `service_role` porque o envio precisa ler as inscrições de todo mundo da
 * organização, e a política da tabela deixa cada um ver só as suas — de
 * propósito: quem está logado em que aparelho não é informação de atendimento.
 * - 2026/08/10
 */

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
);

const MOTIVOS: MotivoDoAviso[] = [
  "complaint",
  "wants_person",
  "cannot_resolve",
  "silence",
  "stale",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const responder = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });

  let corpo: {
    organization_id?: string;
    conversation_id?: string;
    motivo?: string;
    contato?: string | null;
  };

  try {
    corpo = await req.json();
  } catch {
    return responder({ error: "corpo inválido" }, 400);
  }

  if (!corpo.organization_id || !corpo.conversation_id) {
    return responder(
      { error: "organization_id e conversation_id são obrigatórios" },
      400,
    );
  }

  const motivo = MOTIVOS.includes(corpo.motivo as MotivoDoAviso)
    ? corpo.motivo as MotivoDoAviso
    : "stale";

  const resultado = await avisarAEquipe(
    client,
    corpo.organization_id,
    motivo,
    {
      conversationId: corpo.conversation_id,
      contato: corpo.contato ?? null,
    },
  );

  return responder(resultado);
});
