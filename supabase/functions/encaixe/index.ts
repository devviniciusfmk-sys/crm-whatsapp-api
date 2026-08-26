import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { convidarDaFila } from "../agent-client/tools/waitlist.ts";
import type { OrganizationExtra } from "../_shared/types/extra_types.ts";

/**
 * # O relógio do convite de encaixe
 *
 * Quando uma cadeira vaga, a primeira pessoa da fila recebe o convite e o
 * relógio começa a correr. Se ela não responder, a vaga não pode ficar presa a
 * ela para sempre — foi assim que o encaixe deixaria de preencher o que se
 * propôs a preencher: um "quero!" que nunca vem segura a cadeira até o dia
 * passar.
 *
 * Este é o único pedaço do encaixe que precisa de cron. Convidar acontece no
 * instante em que o horário vaga, dentro do próprio cancelamento — o encaixe
 * tem prazo curto, e um cron de dez minutos gastaria um sexto da hora que
 * sobrou antes de abrir a boca.
 *
 * ## Só reoferece o que ainda está livre
 *
 * Entre o convite e o vencimento a cadeira pode ter sido preenchida por outro
 * caminho: quem ligou no balcão, quem marcou pela conversa sem estar na fila.
 * Reoferecer sem conferir mandaria um segundo cliente para um horário ocupado.
 * - 2026/08/10
 */

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
);

/** Quanto tempo o convite espera resposta, quando ninguém configurou. */
const PRAZO_PADRAO_MINUTOS = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { data: convites } = await client
    .from("waitlist")
    .select("id, organization_id, offered_at, offered_for")
    .eq("status", "offered")
    .not("offered_at", "is", null);

  let vencidos = 0;
  let reoferecidos = 0;

  for (const convite of convites ?? []) {
    const { data: org } = await client
      .from("organizations")
      .select("extra")
      .eq("id", convite.organization_id as string)
      .single();

    const extra = (org?.extra ?? {}) as OrganizationExtra & {
      waitlist_timeout_minutes?: number;
      timezone?: string;
    };

    const prazo = (extra.waitlist_timeout_minutes ?? PRAZO_PADRAO_MINUTOS) *
      60 * 1000;

    const esperou = Date.now() -
      new Date(convite.offered_at as string).getTime();

    if (esperou < prazo) continue;

    await client
      .from("waitlist")
      .update({ status: "expired" })
      .eq("id", convite.id as string);

    vencidos++;

    if (!convite.offered_for) continue;

    const quando = new Date(convite.offered_for as string);

    // Já passou: não há cadeira para oferecer a ninguém.
    if (quando.getTime() <= Date.now()) continue;

    const { data: ocupado } = await client
      .from("appointments")
      .select("id")
      .eq("organization_id", convite.organization_id as string)
      .eq("status", "scheduled")
      .eq("starts_at", quando.toISOString())
      .limit(1);

    if (ocupado?.length) continue;

    const proximo = await convidarDaFila(
      client,
      convite.organization_id as string,
      {
        startsAt: quando,
        professionalId: null,
        timeZone: extra.timezone ?? "America/Sao_Paulo",
      },
    );

    if (proximo) reoferecidos++;
  }

  return new Response(
    JSON.stringify({ vencidos, reoferecidos }),
    { headers: { ...corsHeaders, "content-type": "application/json" } },
  );
});
