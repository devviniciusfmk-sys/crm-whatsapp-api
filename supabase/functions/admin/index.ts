import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Context, Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import { createClient, createUnsecureClient } from "../_shared/supabase.ts";
import { isPlatformAdmin } from "../_shared/platform_admin.ts";
import { type User } from "@supabase/supabase-js";

/**
 * # A administração da plataforma sobre as organizações
 *
 *   GET   /admin/organizations           todas as organizações, sem o
 *                                        recorte de RLS
 *   GET   /admin/organizations/:id       uma organização, com quem é membro
 *                                        e o que tem conectado
 *   PATCH /admin/organizations/:id       muda módulos, plano/trial, suspende
 *   GET   /admin/stats                   contagens da plataforma inteira
 *
 * ## Por que não dá pra fazer isto com o cliente comum
 *
 * `organizations` tem RLS: `"members can read their orgs"` só devolve
 * organizações das quais QUEM PERGUNTA é membro (`get_authorized_orgs`). Um
 * operador da plataforma não é membro de organização nenhuma — é dono do
 * sistema, não da conta —, então o cliente comum, mesmo autenticado, sempre
 * devolveria uma lista vazia ou (pior) uma lista que parece completa mas é
 * só a das organizações onde o e-mail do operador por acaso está cadastrado.
 * Foi exatamente esse bug que `admin/dashboard.tsx` e `admin/clients.tsx`
 * tinham antes desta função existir: números que pareciam "da plataforma"
 * e eram, na verdade, só da própria conta de quem estava logado. Esta
 * função usa o `service_role`, que ignora RLS por definição — e por isso
 * cada rota está atrás de `requirePlatformAdmin`. - 2026/08/26
 */

type AppEnv = {
  Variables: {
    user: User;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    log.error(
      `${c.req.method} ${c.req.path} → ${err.status}: ${err.message}`,
      err.cause,
    );
    return c.json({ message: err.message }, err.status);
  }

  log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: "Internal Server Error" }, 500);
});

app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  const client = createClient(c.req.raw);
  const { data: { user }, error } = await client.auth.getUser();

  if (error || !user) {
    throw new HTTPException(401, { message: "Invalid JWT", cause: error });
  }

  c.set("user", user);
  await next();
});

async function requirePlatformAdmin(
  c: Context<AppEnv>,
  next: () => Promise<void>,
) {
  const user = c.get("user");

  if (!isPlatformAdmin(user?.email)) {
    log.error(`User ${user?.id} is not a platform admin`, {
      email: user?.email,
    });
    throw new HTTPException(403, { message: "Not a platform admin." });
  }

  await next();
}

app.use("*", requirePlatformAdmin);

/**
 * Toda organização, sem o recorte de RLS.
 *
 * Campo a campo, não `select("*")` — mesma disciplina de `pagamentos/
 * checkout.ts`: uma coluna nova amanhã não deve vazar aqui sem ninguém
 * decidir que ela devia.
 */
app.get("/admin/organizations", async (c) => {
  const client = createUnsecureClient();

  const { data, error } = await client
    .from("organizations")
    .select("id, name, extra, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw new HTTPException(500, {
      message: "Não consegui listar as organizações.",
      cause: error,
    });
  }

  return c.json(data ?? []);
});

/**
 * Uma organização, e quem é dela — pra tela de detalhe do admin.
 *
 * Traz os agentes (membros, humanos e IA) e os endereços conectados
 * (WhatsApp/Instagram/etc), porque é exatamente o que a tela de detalhe
 * precisa pra responder "quem usa isto" e "o que está ligado" sem uma
 * segunda viagem.
 */
app.get("/admin/organizations/:id", async (c) => {
  const id = c.req.param("id");
  const client = createUnsecureClient();

  const { data: organization, error: orgError } = await client
    .from("organizations")
    .select("id, name, extra, created_at")
    .eq("id", id)
    .maybeSingle();

  if (orgError) {
    throw new HTTPException(500, {
      message: "Não consegui ler a organização.",
      cause: orgError,
    });
  }

  if (!organization) {
    throw new HTTPException(404, { message: "Organização não encontrada." });
  }

  const { data: agents } = await client
    .from("agents")
    .select("id, name, ai, extra, created_at")
    .eq("organization_id", id)
    .order("created_at", { ascending: true });

  const { data: addresses } = await client
    .from("organizations_addresses")
    .select("address, service, status, extra")
    .eq("organization_id", id);

  return c.json({
    organization,
    agents: agents ?? [],
    addresses: addresses ?? [],
  });
});

export type AdminOrganizationUpdate = {
  modules?: string[];
  subscription_status?: "trial" | "active" | "suspended" | "none";
  trial_ends_at?: string | null;
  suspended?: boolean;
};

/**
 * Muda módulos, plano/trial ou suspende — tudo dentro de `extra`.
 *
 * Lê o `extra` atual e mescla o que veio no corpo antes de gravar, em vez
 * de confiar só no merge automático do gatilho `set_extra` do lado do
 * banco. É a mesma cautela que `useUpdateCurrentOrganization` (lado da UI,
 * para o dono da própria organização) já toma com esta tabela específica —
 * repetida aqui porque as duas escritas não compartilham código, e a
 * organização não pode ter dois comportamentos diferentes dependendo de
 * quem a edita.
 */
app.patch("/admin/organizations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<AdminOrganizationUpdate>();
  const client = createUnsecureClient();

  const { data: atual, error: leituraError } = await client
    .from("organizations")
    .select("extra")
    .eq("id", id)
    .maybeSingle();

  if (leituraError || !atual) {
    throw new HTTPException(404, { message: "Organização não encontrada." });
  }

  const extraAtual = (atual.extra as Record<string, unknown>) ?? {};
  const extraNovo: Record<string, unknown> = { ...extraAtual };

  if (body.modules !== undefined) extraNovo.modules = body.modules;
  if (body.subscription_status !== undefined) {
    extraNovo.subscription_status = body.subscription_status;
  }
  if (body.trial_ends_at !== undefined) {
    extraNovo.trial_ends_at = body.trial_ends_at;
  }
  if (body.suspended !== undefined) extraNovo.suspended = body.suspended;

  const { data: organization, error } = await client
    .from("organizations")
    .update({ extra: extraNovo })
    .eq("id", id)
    .select("id, name, extra, created_at")
    .single();

  if (error) {
    throw new HTTPException(500, {
      message: "Não consegui atualizar a organização.",
      cause: error,
    });
  }

  log.info("Admin: organização atualizada", {
    organization_id: id,
    admin: c.get("user").email,
    mudou: Object.keys(body),
  });

  return c.json(organization);
});

/**
 * Contagens da plataforma inteira — a mesma pergunta que `admin/
 * dashboard.tsx` já fazia direto pelo cliente comum, e que a RLS respondia
 * errado (ver o comentário no topo do arquivo).
 */
app.get("/admin/stats", async (c) => {
  const client = createUnsecureClient();
  const now = new Date();
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).toISOString();

  const [orgs, agents, conversations, messages] = await Promise.all([
    client.from("organizations").select("*", { count: "exact", head: true }),
    client.from("agents").select("*", { count: "exact", head: true }).eq(
      "ai",
      true,
    ),
    client.from("conversations").select("*", { count: "exact", head: true })
      .gte("created_at", startOfMonth),
    client.from("messages").select("*", { count: "exact", head: true }).gte(
      "created_at",
      startOfMonth,
    ),
  ]);

  return c.json({
    organizations: orgs.count ?? 0,
    ai_agents: agents.count ?? 0,
    conversations_this_month: conversations.count ?? 0,
    messages_this_month: messages.count ?? 0,
  });
});

/**
 * Receita de verdade — `admin/revenue.tsx` mostrava "R$ 0, sin
 * facturación configurada" fixo, mesmo depois de `billing.payments` e
 * `billing.subscriptions` passarem a existir. As duas tabelas são
 * restritas a "owner da própria organização" por RLS (ver
 * `06-20_rls.sql`), então precisam do mesmo cliente de serviço que
 * `/admin/stats` já usa.
 *
 * `churn` fica de fora de propósito: `billing.subscriptions` não guarda
 * histórico de cancelamento (é uma linha por organização, sobrescrita),
 * então não há como calcular churn sem inventar um número. Melhor a tela
 * continuar dizendo "sem dados suficientes" do que uma conta que parece
 * precisa e não é.
 */
app.get("/admin/revenue", async (c) => {
  const client = createUnsecureClient();
  const now = new Date();
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).toISOString();

  const [pagamentos, assinaturas] = await Promise.all([
    client
      .schema("billing")
      .from("payments")
      .select("amount")
      .eq("status", "succeeded")
      .gte("created_at", startOfMonth),
    client
      .schema("billing")
      .from("subscriptions")
      .select("plans(price, billing_cycle)")
      .not("plan_id", "is", null),
  ]);

  const ingresos_del_mes = (pagamentos.data ?? []).reduce(
    (soma, p) => soma + Number(p.amount),
    0,
  );

  // MRR: mensaliza o que é anual. Hoje só existe `month` no catálogo, mas
  // a conta já fica certa no dia em que um plano anual for vendido.
  const mrr = (assinaturas.data ?? []).reduce((soma, s) => {
    const plano = s.plans as { price: number; billing_cycle: string | null } | null;
    if (!plano) return soma;
    const mensal = plano.billing_cycle === "year"
      ? plano.price / 12
      : plano.price;
    return soma + mensal;
  }, 0);

  return c.json({
    ingresos_del_mes,
    mrr,
    // Sem histórico de cancelamento, não tem como calcular — ver o
    // comentário acima da rota.
    churn: null,
  });
});

Deno.serve(app.fetch);
