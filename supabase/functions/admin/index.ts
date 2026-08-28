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
  return c.json(
    { message: err instanceof Error ? err.message : "Internal Server Error" },
    500,
  );
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

  const [
    { data, error },
    { data: assinaturas },
    { data: donos },
    { data: enderecos },
  ] = await Promise.all([
    client
      .from("organizations")
      .select("id, name, extra, created_at")
      .order("created_at", { ascending: false }),
    client
      .schema("billing")
      .from("subscriptions")
      .select("organization_id, plan_id, tier_id, trial_ends_at"),
    client
      .from("agents")
      .select("organization_id, user_id")
      .eq("extra->>role", "owner"),
    client
      .from("organizations_addresses")
      .select("organization_id, service"),
  ]);

  if (error) {
    throw new HTTPException(500, {
      message: "Não consegui listar as organizações.",
      cause: error,
    });
  }

  const assinaturaPorOrg = new Map(
    (assinaturas ?? []).map((s) => [
      s.organization_id,
      {
        plan_id: s.plan_id,
        tier_id: s.tier_id,
        trial_ends_at: s.trial_ends_at,
      },
    ]),
  );

  // "local" é o endereço de teste que todo cadastro ganha sozinho (ver
  // `after_insert_on_organizations`) — não é um canal real conectado, e
  // contá-lo faria toda organização parecer que já tem WhatsApp.
  const canaisPorOrg = new Map<string, number>();
  for (const e of enderecos ?? []) {
    if (e.service === "local") continue;
    canaisPorOrg.set(e.organization_id, (canaisPorOrg.get(e.organization_id) ?? 0) + 1);
  }

  // E-mail mora em `auth.users`, fora do alcance de um `.select()` comum —
  // só a API de admin do Auth enxerga. Um `getUserById` por dono, em
  // paralelo: são poucas organizações, não um relatório de milhares.
  const emailPorOrg = new Map<string, string>();
  await Promise.all(
    (donos ?? [])
      .filter((d): d is { organization_id: string; user_id: string } => !!d.user_id)
      .map(async (d) => {
        const { data: userData } = await client.auth.admin.getUserById(d.user_id);
        if (userData?.user?.email) emailPorOrg.set(d.organization_id, userData.user.email);
      }),
  );

  const comAssinatura = (data ?? []).map((org) => ({
    ...org,
    subscription: assinaturaPorOrg.get(org.id) ?? null,
    owner_email: emailPorOrg.get(org.id) ?? null,
    canais_conectados: canaisPorOrg.get(org.id) ?? 0,
  }));

  return c.json(comAssinatura);
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

  const { data: assinatura } = await client
    .schema("billing")
    .from("subscriptions")
    .select("plan_id, tier_id, trial_ends_at")
    .eq("organization_id", id)
    .maybeSingle();

  const { data: dono } = await client
    .from("agents")
    .select("user_id")
    .eq("organization_id", id)
    .eq("extra->>role", "owner")
    .not("user_id", "is", null)
    .limit(1)
    .maybeSingle();

  let ownerEmail: string | null = null;
  if (dono?.user_id) {
    const { data: userData } = await client.auth.admin.getUserById(dono.user_id);
    ownerEmail = userData?.user?.email ?? null;
  }

  return c.json({
    organization: {
      ...organization,
      subscription: assinatura ?? null,
      owner_email: ownerEmail,
    },
    agents: agents ?? [],
    addresses: addresses ?? [],
  });
});

export type AdminOrganizationUpdate = {
  modules?: string[];
  suspended?: boolean;
  /** Chama `billing.change_plan` — a mesma função que já rege upgrade em
   * qualquer outro lugar do produto, pra "o operador troca o plano de um
   * cliente" nunca poder divergir de "um cliente muda de plano sozinho". */
  plan_id?: string;
  /** Prorrogação/cortesia manual, direto em `billing.subscriptions`. A
   * criação normal do trial (7 dias) já acontece sozinha no gatilho — isto
   * é só para o caso de negociação que o gatilho não cobre. */
  trial_ends_at?: string | null;
  /** Quando `modules` liga um add-on pago (hoje só `iptv`) SEM plano pago,
   * `cortesia: true` é a única forma de passar: pula a checagem de plano e
   * marca o módulo em `extra.modulos_cortesia`, pra nunca confundir "cliente
   * pagando" com "operador liberou de graça" num relatório. */
  cortesia?: boolean;
};

/** Só `iptv` é add-on pago hoje — mesma lista que `src/utils/modules.ts`
 * (`addonPago: true`) do lado da UI. Hardcoded aqui em vez de compartilhada
 * entre os dois repositórios porque é uma linha só; duplicar a lista
 * inteira de módulos só pra isto seria mais acoplamento do que o problema
 * pede. */
const ADDONS_PAGOS = new Set(["iptv"]);

/**
 * Muda módulos, plano/trial ou suspende uma organização.
 *
 * `modules` e `suspended` continuam em `extra` (não são billing — são
 * capacidade e trinco de acesso, respectivamente). `plan_id` e
 * `trial_ends_at` foram MOVIDOS pra `billing.subscriptions` — só ficaram em
 * `extra.subscription_status`/`extra.trial_ends_at` até 2026/08/27, um
 * sistema paralelo sem nenhuma regra de negócio, que podia discordar do
 * `billing.subscriptions` real que a própria organização vê em
 * `/stats/quotas`. Ver `06_billing` no schema.
 */
app.patch("/admin/organizations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<AdminOrganizationUpdate>();
  const client = createUnsecureClient();

  if (body.modules !== undefined || body.suspended !== undefined) {
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

    if (body.modules !== undefined) {
      const modulosAtuais = new Set(
        (extraAtual.modules as string[] | undefined) ?? [],
      );
      const novosModulos = new Set(body.modules);
      const cortesiaAtual = new Set(
        (extraAtual.modulos_cortesia as string[] | undefined) ?? [],
      );

      const ligandoAddonPago = [...ADDONS_PAGOS].find(
        (m) => novosModulos.has(m) && !modulosAtuais.has(m),
      );

      if (ligandoAddonPago && !body.cortesia) {
        const { data: assinaturaAtual } = await client
          .schema("billing")
          .from("subscriptions")
          .select("plan_id")
          .eq("organization_id", id)
          .maybeSingle();

        if (!assinaturaAtual?.plan_id || assinaturaAtual.plan_id === "free") {
          throw new HTTPException(400, {
            message:
              "IPTV é add-on pago — a organização precisa estar num plano pago (não free) antes de ligar, a não ser que seja cortesia.",
          });
        }
      }

      // `modulos_cortesia` só existe pra add-ons pagos, e só enquanto o
      // módulo continuar ligado — desligar o checkbox tira da lista de
      // cortesia junto, pra não sobrar um registro "cortesia" de um módulo
      // que nem está mais ativo.
      const cortesiaNova = new Set(
        [...cortesiaAtual].filter((m) => novosModulos.has(m)),
      );
      if (body.cortesia && ligandoAddonPago) cortesiaNova.add(ligandoAddonPago);

      extraNovo.modules = body.modules;
      extraNovo.modulos_cortesia = [...cortesiaNova];
    }
    if (body.suspended !== undefined) extraNovo.suspended = body.suspended;

    const { error } = await client
      .from("organizations")
      .update({ extra: extraNovo })
      .eq("id", id);

    if (error) {
      throw new HTTPException(500, {
        message: "Não consegui atualizar a organização.",
        cause: error,
      });
    }
  }

  if (body.plan_id !== undefined) {
    const { error } = await client
      .schema("billing")
      .rpc("change_plan", { _organization_id: id, _plan_id: body.plan_id });

    if (error) {
      throw new HTTPException(500, {
        message: "Não consegui trocar o plano.",
        cause: error,
      });
    }
  }

  if (body.trial_ends_at !== undefined) {
    const { error } = await client
      .schema("billing")
      .from("subscriptions")
      .update({ trial_ends_at: body.trial_ends_at })
      .eq("organization_id", id);

    if (error) {
      throw new HTTPException(500, {
        message: "Não consegui atualizar o fim do trial.",
        cause: error,
      });
    }
  }

  const { data: organization, error: releituraError } = await client
    .from("organizations")
    .select("id, name, extra, created_at")
    .eq("id", id)
    .single();

  if (releituraError) {
    throw new HTTPException(500, {
      message: "Não consegui reler a organização.",
      cause: releituraError,
    });
  }

  const { data: assinatura } = await client
    .schema("billing")
    .from("subscriptions")
    .select("plan_id, tier_id, trial_ends_at")
    .eq("organization_id", id)
    .maybeSingle();

  log.info("Admin: organização atualizada", {
    organization_id: id,
    admin: c.get("user").email,
    mudou: Object.keys(body),
  });

  return c.json({ ...organization, subscription: assinatura ?? null });
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
