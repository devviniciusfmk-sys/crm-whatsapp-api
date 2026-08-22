import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { ErroDoPainel, pedirTeste, procurarPorUsuario } from "./painel.ts";
import { renderizar, TEXTO_PADRAO } from "./texto.ts";

/**
 * # A porta do IPTV
 *
 *   POST /iptv/teste   gera um teste e manda as credenciais na conversa
 *
 * ## Isolada de propósito
 *
 * Função de borda separada, sem ligação com o assistente nem com a agenda. Um
 * painel fora do ar, um token trocado ou uma resposta malformada não podem
 * parar o atendimento — que é o produto. É a mesma decisão de `pagamentos`,
 * pelo mesmo motivo.
 *
 * ## O que ela decide, e o que ela não decide
 *
 * Decide: se pode gerar, se já existe teste vivo, o que escrever, e o que
 * gravar. Não decide o que o painel devolve nem se a Meta entrega a mensagem —
 * as duas coisas são de fora, e as duas podem falhar depois de o teste já ter
 * sido criado lá. Por isso a ordem é sempre: falar com o painel, gravar o que
 * ele deu, e só então tentar mandar. Gravar por último perderia a credencial
 * que o cliente já pode estar usando. - 2026/08/22
 */

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });

/** Só os dígitos: é assim que dois telefones se comparam. */
const soDigitos = (texto: string) => texto.replace(/\D/g, "");

/** "25/12/2026 às 18:30", no fuso de quem lê. */
function quando(iso: string, timezone: string) {
  const data = new Date(iso);

  const dia = data.toLocaleDateString("pt-BR", { timeZone: timezone });
  const hora = data.toLocaleTimeString("pt-BR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${dia} às ${hora}`;
}

/**
 * Onde o robô do painel mora, com a precedência que a configuração permite.
 *
 * Do mais específico para o mais geral: o app pode ter o dele, o pacote pode
 * ter o dele, e o servidor é o último recurso. Existe porque cada pacote
 * costuma ter um endereço próprio, e a loja que troca de pacote não deveria
 * reconfigurar o servidor inteiro.
 */
function urlDoRobo(
  servidor: { base_url: string },
  pacote: { bot_url?: string | null; bot_path?: string | null },
): string {
  if (pacote.bot_url?.trim()) return pacote.bot_url.trim();

  const base = servidor.base_url.replace(/\/+$/, "");

  return pacote.bot_path?.trim()
    ? `${base}/api/chatbot/${pacote.bot_path.trim().replace(/^\/+/, "")}`
    : `${base}/api/chatbot/`;
}

/**
 * Manda o texto pela conversa.
 *
 * Uma linha em `messages`, como todo o resto do produto: é o gatilho de saída
 * que despacha, e escrever direto na Meta daqui seria um segundo caminho de
 * envio — sem histórico, sem janela de 24 horas, sem status de entrega.
 */
async function mandar(
  conversationId: string,
  organizationId: string,
  texto: string,
) {
  const { data: conversa } = await client
    .from("conversations")
    .select("id, service, organization_address, contact_address")
    .eq("id", conversationId)
    .single();

  if (!conversa) return false;

  const { error } = await client.from("messages").insert({
    conversation_id: conversa.id,
    organization_id: organizationId,
    organization_address: conversa.organization_address,
    service: conversa.service,
    contact_address: conversa.contact_address,
    direction: "outgoing",
    content: { version: "1", type: "text", kind: "text", text: texto },
  });

  return !error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const qual = url.pathname.split("/").filter(Boolean).at(-1) ?? "";

  if (qual !== "teste") {
    return json({ erro: `rota desconhecida: ${qual}` }, 404);
  }

  const corpo = (await req.json().catch(() => ({}))) as {
    organizacao?: string;
    conversa?: string;
    contato?: string;
    telefone?: string;
    nome?: string;
    pacote?: string;
    app?: string;
    agente?: string;
  };

  const { organizacao, conversa, telefone, app } = corpo;

  if (!organizacao || !telefone || !app) {
    return json({ erro: "faltou organização, telefone ou app" }, 400);
  }

  /**
   * O pacote: o pedido, ou o primeiro que estiver de pé.
   *
   * O `join` traz o servidor junto porque as duas coisas são conferidas na
   * mesma linha — e porque um pacote ativo dentro de um servidor desligado é
   * um caso que existe e não pode passar.
   */
  const consulta = client
    .from("iptv_pacotes")
    .select(
      "id, name, telas, duracao_horas, bot_url, bot_path, is_active, " +
        "servidor:iptv_servidores!inner(" +
        "id, name, base_url, painel_url, painel_user_id, is_active, " +
        "trial_horas, organization_id)",
    )
    .eq("is_active", true)
    .eq("servidor.is_active", true)
    .eq("servidor.organization_id", organizacao);

  const { data: pacotes } = corpo.pacote
    ? await consulta.eq("id", corpo.pacote).limit(1)
    : await consulta.order("created_at", { ascending: true }).limit(1);

  const pacote = pacotes?.[0] as
    | {
      id: string;
      name: string;
      telas: number;
      duracao_horas: number | null;
      bot_url: string | null;
      bot_path: string | null;
      servidor: {
        id: string;
        name: string;
        base_url: string;
        painel_url: string | null;
        painel_user_id: string | null;
        trial_horas: number;
      };
    }
    | undefined;

  if (!pacote) {
    /**
     * A mesma resposta para "não existe" e para "está desligado", e é de
     * propósito: as duas se resolvem no mesmo lugar, e distinguir aqui
     * significaria consultar de novo sem os filtros só para escrever uma frase
     * diferente. O que a tela precisa saber é que não há de onde gerar.
     */
    return json({ erro: "nenhum pacote ativo em servidor ativo" }, 409);
  }

  const servidor = pacote.servidor;

  const { data: appConfig } = await client
    .from("iptv_apps")
    .select("app, is_enabled, codigo, texto, display_name")
    .eq("pacote_id", pacote.id)
    .eq("app", app)
    .maybeSingle();

  if (appConfig && !appConfig.is_enabled) {
    return json({ erro: "este app está desligado neste pacote" }, 409);
  }

  const fuso = "America/Sao_Paulo";

  /**
   * # O guarda do reuso
   *
   * Antes de falar com o painel: este telefone já tem teste vivo aqui?
   *
   * Sem ele, o cliente que pede duas vezes em dez minutos — o que acontece
   * sempre, porque a primeira mensagem "sumiu" na conversa — consome dois
   * créditos do painel e recebe dois usuários diferentes. E aí ele pergunta
   * qual usar, que é uma conversa que ninguém quer ter.
   *
   * Casa por servidor E app, como a especificação define: o mesmo cliente
   * testando o Vizzion e o XCIPTV precisa de credenciais próprias, porque o
   * código de ativação é de cada um.
   */
  const { data: vivos } = await client
    .from("iptv_testes")
    .select("id, username, password, codigo, dns, m3u_url, expira_em, app")
    .eq("organization_id", organizacao)
    .eq("contact_address", soDigitos(telefone))
    .eq("servidor_id", servidor.id)
    .eq("app", app)
    .eq("status", "ativo")
    .gt("expira_em", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  const molde = appConfig?.texto?.trim() || TEXTO_PADRAO;

  const { data: codigosDoPacote } = await client
    .from("iptv_apps")
    .select("app, codigo")
    .eq("pacote_id", pacote.id);

  const codigos = Object.fromEntries(
    (codigosDoPacote ?? [])
      .filter((linha) => linha.codigo)
      .map((linha) => [linha.app, linha.codigo as string]),
  );

  const horas = pacote.duracao_horas ?? servidor.trial_horas;

  if (vivos?.[0]) {
    const vivo = vivos[0];

    const texto = renderizar(molde, {
      username: vivo.username,
      password: vivo.password ?? undefined,
      codigo: vivo.codigo ?? undefined,
      dns: vivo.dns ?? undefined,
      m3u_url: vivo.m3u_url ?? undefined,
      duracao: horas,
      expira: quando(vivo.expira_em, fuso),
      plano: pacote.name,
      telas: pacote.telas,
      nome: corpo.nome,
      codigos,
      comprado: false,
    });

    if (conversa) await mandar(conversa, organizacao, texto);

    return json({ reusado: true, teste: vivo.id, texto });
  }

  const { data: token } = await client.rpc("get_iptv_token", {
    p_servidor_id: servidor.id,
  });

  if (!token) {
    return json({ erro: "este servidor não tem token configurado" }, 409);
  }

  const painel = {
    base_url: servidor.base_url,
    painel_url: servidor.painel_url,
    painel_user_id: servidor.painel_user_id,
    token: token as string,
  };

  let credenciais;

  try {
    credenciais = await pedirTeste(painel, urlDoRobo(servidor, pacote));
  } catch (erro) {
    const detalhe = erro instanceof ErroDoPainel
      ? { status: erro.status, mensagem: erro.message }
      : { mensagem: String(erro) };

    console.error("[iptv] painel recusou", servidor.name, detalhe);

    /* 200 com `ok: false`, e não um código de erro: quem falhou foi o painel,
     * não este pedido. A tela precisa da MENSAGEM para mostrar, e um 4xx faria
     * o cliente de consultas tratar como falha de rede e esconder justamente o
     * que a pessoa precisa ler. Mesma decisão de `pagamentos/testar`. */
    return json({ ok: false, ...detalhe });
  }

  if (!credenciais.username) {
    return json({ ok: false, mensagem: "o painel não devolveu usuário" });
  }

  /**
   * # A confirmação, por USUÁRIO
   *
   * O painel dizer 200 não é o mesmo que o cliente existir. E a confirmação é
   * por usuário e nunca pelo id que ele devolve: aquele id é um hashid
   * ambíguo, e o mesmo valor aponta para clientes diferentes em contextos
   * diferentes — confirmar por ele devolve o cliente errado sem estourar nada.
   *
   * Falhar aqui NÃO cancela o teste: o usuário pode existir e a consulta ter
   * caído. Fica no log, e o registro é gravado do mesmo jeito — perder a
   * credencial que o cliente já pode estar usando é o erro mais caro possível.
   */
  const confirmado = await procurarPorUsuario(painel, credenciais.username);

  if (!confirmado) {
    console.warn(
      "[iptv] criado mas não confirmado",
      servidor.name,
      credenciais.username,
    );
  }

  const comeca = new Date();
  const expira = new Date(comeca.getTime() + horas * 3600_000);

  const { data: teste, error: erroAoGravar } = await client
    .from("iptv_testes")
    .insert({
      organization_id: organizacao,
      conversation_id: conversa ?? null,
      contact_id: corpo.contato ?? null,
      contact_address: soDigitos(telefone),
      servidor_id: servidor.id,
      servidor_nome: servidor.name,
      pacote_id: pacote.id,
      pacote_nome: pacote.name,
      app,
      username: credenciais.username,
      password: credenciais.password,
      codigo: appConfig?.codigo ?? null,
      dns: credenciais.dns ?? null,
      m3u_url: credenciais.m3u_url ?? null,
      duracao_horas: horas,
      comeca_em: comeca.toISOString(),
      expira_em: expira.toISOString(),
      vendido_por: corpo.agente ?? null,
    })
    .select()
    .single();

  if (erroAoGravar) {
    /* O teste EXISTE no painel e não existe aqui. É o pior estado possível, e
     * por isso ele vai para o log com a credencial: alguém consegue lançar à
     * mão, e ninguém consegue adivinhar. */
    console.error("[iptv] criado no painel e NÃO gravado", {
      servidor: servidor.name,
      username: credenciais.username,
      erro: erroAoGravar.message,
    });

    return json({ ok: false, mensagem: erroAoGravar.message });
  }

  const texto = renderizar(molde, {
    username: credenciais.username,
    password: credenciais.password,
    codigo: appConfig?.codigo ?? undefined,
    dns: credenciais.dns,
    m3u_url: credenciais.m3u_url,
    lista_url: credenciais.lista_url,
    duracao: horas,
    expira: quando(expira.toISOString(), fuso),
    plano: credenciais.plano || pacote.name,
    telas: pacote.telas,
    nome: corpo.nome,
    codigos,
    comprado: false,
  });

  const enviou = conversa ? await mandar(conversa, organizacao, texto) : false;

  return json({ ok: true, teste: teste.id, enviou, texto });
});
