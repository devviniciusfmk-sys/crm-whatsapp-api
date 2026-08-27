import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createUnsecureClient } from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";

/**
 * Traz os leads de uma base externa (um Supabase separado que raspa e
 * pontua prospects por IA) pra dentro do funil de vendas (`negocios`).
 *
 * Chamada por `pg_cron` a cada 30 minutos — ver a migração
 * `cron_sync_leads`. O upsert de verdade mora em
 * `sincronizar_negocios_externos` (`04-32_negocios_sync.sql`): esta função
 * só busca, junta e manda o lote — a regra de "nunca sobrescrever o que um
 * humano já mexeu" fica no banco, não aqui.
 *
 * ## apikey === Authorization, sempre
 *
 * A base externa usa o formato novo de chave do Supabase (`sb_secret_...`).
 * Descoberto nesta mesma leva de trabalho (migração da service_role key
 * própria): esse formato não é JWT — não carrega `role` embutido — então o
 * gateway só resolve o papel quando `apikey` e `Authorization` são
 * EXATAMENTE a mesma chave. Um `apikey` diferente (como a anon key) devolve
 * 401 "Expected 3 parts in JWT". Por isso os dois headers abaixo repetem o
 * mesmo valor.
 */

const SERVICE_ROLE_KEY = Deno.env.get("SB_SECRET_KEY");
const LEADS_ORGANIZATION_ID = Deno.env.get("LEADS_ORGANIZATION_ID");
const PAGE_SIZE = 1000;

type LeadExterno = {
  id: string;
  name: string | null;
  phone: string | null;
  city: string | null;
  category: string | null;
  nicho: string | null;
  status: string | null;
  opportunity_score: number | null;
  combined_score: number | null;
};

type LeadScoreExterno = {
  lead_id: string;
  verdict: string | null;
  reason_short: string | null;
  suggested_opener: string | null;
  matched_pains: unknown;
  created_at: string;
};

async function buscarTudo<T>(
  baseUrl: string,
  chave: string,
  tabela: string,
  colunaDeOrdem: string,
): Promise<T[]> {
  const linhas: T[] = [];
  let inicio = 0;

  while (true) {
    const resposta = await fetch(
      `${baseUrl}/rest/v1/${tabela}?select=*&order=${colunaDeOrdem}`,
      {
        headers: {
          apikey: chave,
          authorization: `Bearer ${chave}`,
          range: `${inicio}-${inicio + PAGE_SIZE - 1}`,
        },
      },
    );

    if (!resposta.ok) {
      throw new Error(
        `falha ao buscar ${tabela} da base externa: ${resposta.status} ${await resposta.text()}`,
      );
    }

    const pagina = (await resposta.json()) as T[];

    linhas.push(...pagina);

    if (pagina.length < PAGE_SIZE) break;
    inicio += PAGE_SIZE;
  }

  return linhas;
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!LEADS_ORGANIZATION_ID) {
    return Response.json(
      { erro: "LEADS_ORGANIZATION_ID não configurado" },
      { status: 503 },
    );
  }

  const client = createUnsecureClient();

  const { data: config, error: erroConfig } = await client
    .rpc("get_leads_externos_config")
    .single();

  if (erroConfig || !config?.url || !config?.secret_key) {
    return Response.json(
      { erro: "credencial da base externa não configurada" },
      { status: 503 },
    );
  }

  const [leads, scores] = await Promise.all([
    buscarTudo<LeadExterno>(config.url, config.secret_key, "leads", "id"),
    buscarTudo<LeadScoreExterno>(
      config.url,
      config.secret_key,
      "lead_scores",
      "lead_id",
    ),
  ]);

  // Um lead pode ter sido pontuado mais de uma vez — fica só a mais recente.
  const scorePorLead = new Map<string, LeadScoreExterno>();

  for (const score of scores) {
    const atual = scorePorLead.get(score.lead_id);

    if (!atual || score.created_at > atual.created_at) {
      scorePorLead.set(score.lead_id, score);
    }
  }

  const linhas = leads.map((lead) => {
    const score = scorePorLead.get(lead.id);

    return {
      organization_id: LEADS_ORGANIZATION_ID,
      externo_id: lead.id,
      origem: "leads_externos",
      nome: lead.name ?? lead.id,
      telefone: lead.phone,
      cidade: lead.city,
      categoria: lead.category,
      nicho: lead.nicho,
      score_ia: lead.combined_score ?? lead.opportunity_score,
      veredito_ia: score?.verdict ?? null,
      motivo_ia: score?.reason_short ?? null,
      abertura_sugerida: score?.suggested_opener ?? null,
      dores_identificadas: score?.matched_pains ?? null,
    };
  });

  const { data: linhasAfetadas, error: erroSync } = await client.rpc(
    "sincronizar_negocios_externos",
    { p_linhas: linhas },
  );

  if (erroSync) throw erroSync;

  log.info("leads-sync concluído", {
    recebidos: leads.length,
    sincronizados: linhasAfetadas,
  });

  return Response.json({ recebidos: leads.length, sincronizados: linhasAfetadas });
});
