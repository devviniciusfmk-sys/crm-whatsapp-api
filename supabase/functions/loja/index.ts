import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Context, Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import {
  createClient,
  createUnsecureClient,
  type Json,
} from "../_shared/supabase.ts";
import { isPlatformAdmin } from "../_shared/platform_admin.ts";
import { type User } from "@supabase/supabase-js";

/**
 * # A loja de números
 *
 *   GET  /loja/vitrine          o catálogo de números à venda
 *   POST /loja/admin/numeros    cadastrar um número no estoque
 *   GET  /loja/admin/numeros    o estoque inteiro, todo status
 *   GET  /loja/admin/pedidos    a fila de entrega (pedidos pagos)
 *
 * Função separada de `pagamentos` e `whatsapp-management` de propósito, do
 * mesmo jeito que `iptv` é separada de tudo: um bug aqui não pode derrubar o
 * checkout de uma loja nem a conexão de um número já existente, que são o
 * produto de verdade. Esta função é a vitrine da PLATAFORMA vendendo um
 * pedaço de si mesma — um item a mais no catálogo, não o catálogo principal.
 *
 * ## O estilo, e por que este e não o de `pagamentos`/`iptv`
 *
 * `pagamentos` e `iptv` são `Deno.serve` cru porque quase todas as rotas
 * deles não têm login — um cliente anônimo pedindo um Pix, um robô de painel
 * IPTV. Aqui é o oposto: toda rota exige JWT, e a única pergunta que muda de
 * rota para rota é "precisa ser ADMIN da plataforma, ou só estar logado?" —
 * exatamente o formato que `whatsapp-management/index.ts` já resolve com
 * Hono e um `c.get("user")` populado uma vez, num middleware global. Seguir
 * esse estilo aqui é reaproveitar uma decisão já tomada, não inventar uma
 * terceira. - 2026/08/26
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
    return c.json(
      { message: err.message, cause: err.cause as Json },
      err.status,
    );
  }

  log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: "Internal Server Error" }, 500);
});

// Toda rota exige JWT. Esta loja não tem checkout anônimo (diferente de
// `pagamentos/checkout.ts`, que existe justamente para quem não tem conta) e
// não tem chamador por API key (nenhuma integração externa fala com ela).
// Todo visitante é um humano logado, membro de alguma organização — o que
// muda por rota é só se isso já basta ou se precisa ser o operador da
// plataforma.
app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  const client = createClient(c.req.raw);

  const { data: { user }, error } = await client.auth.getUser();

  if (error || !user) {
    log.error("Invalid JWT", error);
    throw new HTTPException(401, { message: "Invalid JWT", cause: error });
  }

  c.set("user", user);

  await next();
});

/**
 * Gate do operador da plataforma. Não é o mesmo objeto que o middleware de
 * `whatsapp-management/index.ts` — cada função de borda tem o seu próprio
 * `AppEnv`/contexto Hono, e as duas não têm como compartilhar um middleware
 * tipado sem acoplar duas funções que o Supabase implanta e escala
 * separadamente. O que NÃO se duplica é a lista de e-mails: ambas importam
 * `isPlatformAdmin` de `_shared/platform_admin.ts`, que é a única fonte da
 * verdade sobre quem é operador.
 */
async function requirePlatformAdmin(
  c: Context<AppEnv>,
  next: () => Promise<void>,
) {
  const user = c.get("user");

  if (!isPlatformAdmin(user?.email)) {
    throw new HTTPException(403, { message: "Not a platform admin." });
  }

  await next();
}

/**
 * O catálogo, para qualquer membro logado.
 *
 * Sem checagem de papel ou de organização: qualquer pessoa logada em
 * qualquer organização pode olhar a vitrine, do mesmo jeito que qualquer
 * pessoa pode olhar uma loja física sem ser dona de nada. Quem decide se
 * compra é a rota de compra (`POST /pagamentos/loja/comprar`), que exige
 * owner — esta aqui só mostra o que existe.
 */
app.get("/loja/vitrine", async (c) => {
  const client = createUnsecureClient();

  const { data, error } = await client
    .from("loja_numeros")
    .select("id, phone_number, verified_name, preco")
    .eq("status", "disponivel");

  if (error) {
    throw new HTTPException(500, {
      message: "Não consegui ler a vitrine.",
      cause: error,
    });
  }

  /* Campo a campo, e não `select("*")`: `phone_number_id`, `waba_id` e o
   * status interno não têm uso nesta tela e não são informação para quem só
   * está comprando um número — mesma disciplina de `lerCheckout` em
   * `pagamentos/checkout.ts`, pela mesma razão: um `select("*")` que ganhe
   * uma coluna nova amanhã vaza essa coluna aqui sem ninguém perceber. */
  return c.json(data ?? []);
});

/**
 * Cadastra um número no estoque.
 *
 * O token nunca é gravado na linha — só `set_loja_numero_token` o leva ao
 * Vault. A resposta devolve a linha inserida, e ela é naturalmente segura de
 * devolver: o token nunca esteve nela para vazar.
 */
app.post("/loja/admin/numeros", requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{
    phone_number_id: string;
    waba_id: string;
    business_id?: string;
    phone_number?: string;
    verified_name?: string;
    preco?: number;
    token: string;
  }>();

  const required: (keyof typeof body)[] = [
    "phone_number_id",
    "waba_id",
    "token",
  ];

  for (const field of required) {
    if (!body[field]) {
      throw new HTTPException(400, {
        message: `Missing '${field}' body param!`,
      });
    }
  }

  const client = createUnsecureClient();

  const { data: numero, error } = await client
    .from("loja_numeros")
    .insert({
      phone_number_id: body.phone_number_id,
      waba_id: body.waba_id,
      business_id: body.business_id,
      phone_number: body.phone_number,
      verified_name: body.verified_name,
      preco: body.preco,
    })
    .select(
      "id, phone_number_id, waba_id, business_id, phone_number, verified_name, preco, status, criado_em",
    )
    .single();

  if (error || !numero) {
    throw new HTTPException(500, {
      message: "Não consegui cadastrar o número.",
      cause: error,
    });
  }

  const { error: tokenError } = await client.rpc("set_loja_numero_token", {
    p_numero_id: numero.id,
    p_token: body.token,
  });

  if (tokenError) {
    // O número já foi inserido; sem o token ele fica visível no estoque mas
    // inutilizável até alguém rodar `set_loja_numero_token` de novo à mão.
    // Melhor isso do que apagar a linha às pressas: apagar esconderia do
    // operador que o cadastro quase deu certo, e ele tentaria de novo sem
    // saber que já existe um número duplicado parado.
    throw new HTTPException(500, {
      message: "Número cadastrado, mas não consegui guardar o token no cofre.",
      cause: tokenError,
    });
  }

  log.info("Loja: número cadastrado no estoque", {
    numero_id: numero.id,
    admin: c.get("user").email,
  });

  return c.json(numero, 201);
});

/** O estoque inteiro, todo status — só o operador vê a linha crua. */
app.get("/loja/admin/numeros", requirePlatformAdmin, async (c) => {
  const client = createUnsecureClient();

  const { data, error } = await client
    .from("loja_numeros")
    .select("*")
    .order("criado_em", { ascending: false });

  if (error) {
    throw new HTTPException(500, {
      message: "Não consegui listar os números.",
      cause: error,
    });
  }

  return c.json(data ?? []);
});

/**
 * A fila de entrega: pedidos pagos, esperando um clique em "Conectar"
 * (`POST /whatsapp-management/loja/entregar`).
 */
app.get("/loja/admin/pedidos", requirePlatformAdmin, async (c) => {
  const client = createUnsecureClient();

  const { data, error } = await client
    .from("loja_pedidos")
    .select(
      "*, organizations(name), loja_numeros(phone_number, verified_name)",
    )
    .eq("status", "pago")
    .order("criado_em", { ascending: false });

  if (error) {
    throw new HTTPException(500, {
      message: "Não consegui listar os pedidos.",
      cause: error,
    });
  }

  return c.json(data ?? []);
});

Deno.serve(app.fetch);
