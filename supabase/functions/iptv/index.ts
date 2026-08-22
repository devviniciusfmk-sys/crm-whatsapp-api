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

  const { organizacao, conversa, telefone } = corpo;

  if (!organizacao || !telefone) {
    return json({ erro: "faltou organização ou telefone" }, 400);
  }

  /**
   * Sem app é o caso comum de quem só colou o link.
   *
   * O painel devolve uma mensagem que já cita todos os aplicativos dele, e
   * exigir a escolha de um seria uma pergunta cuja resposta não muda nada.
   * `padrao` é um nome só para o teste ter um app gravado — o reuso casa por
   * servidor E app, e sem nenhum valor ali dois pedidos seguidos não se
   * reconheceriam.
   */
  const app = corpo.app?.trim() || "padrao";

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

  /**
   * O fuso da loja, e não um fixo.
   *
   * Ele decide duas coisas: como a data aparece na mensagem, e como se lê a
   * hora que o painel manda — que vem local e sem fuso nenhum. Ver `comoIso`
   * em `painel.ts`.
   */
  const { data: orgRow } = await client
    .from("organizations")
    .select("extra")
    .eq("id", organizacao)
    .maybeSingle();

  const fuso =
    (orgRow?.extra as { timezone?: string } | null)?.timezone ||
    "America/Sao_Paulo";

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

  /* No reuso não há `reply`: ele veio na resposta de uma chamada que não
   * vamos repetir — é justamente o que o reuso evita. Fica o texto da loja
   * ou o padrão. */
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

  /**
   * # O token é OPCIONAL para gerar teste
   *
   * O robô do painel não pede token: ele é o mesmo endereço que responde no
   * site do revendedor, aberto a quem tiver o link. Medido contra um servidor
   * real em 2026/08/22 — uma chamada sem credencial nenhuma devolveu usuário,
   * senha, DNS e a mensagem inteira.
   *
   * A primeira versão exigia o token aqui e recusava com 409. Isso obrigava a
   * loja a caçar uma credencial de API para fazer a coisa mais simples que o
   * módulo faz — e era eu impondo um requisito que o painel não impõe.
   *
   * O token continua sendo necessário para o que é do painel administrativo:
   * confirmar o usuário criado, criar cliente pago e renovar. Sem ele, o que
   * se perde é a CONFERÊNCIA, e não o teste.
   */
  const { data: token } = await client.rpc("get_iptv_token", {
    p_servidor_id: servidor.id,
  });

  const painel = {
    /* Sem endereço cadastrado, a origem sai do próprio link — que é o único
     * campo que a loja precisa colar. */
    base_url: servidor.base_url || urlDoRobo(servidor, pacote),
    painel_url: servidor.painel_url,
    painel_user_id: servidor.painel_user_id,
    token: (token as string | null) ?? "",
  };

  let credenciais;

  try {
    credenciais = await pedirTeste(
      painel,
      urlDoRobo(servidor, pacote),
      fetch,
      fuso,
    );
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
  if (painel.token) {
    const confirmado = await procurarPorUsuario(painel, credenciais.username);

    if (!confirmado) {
      console.warn(
        "[iptv] criado mas não confirmado",
        servidor.name,
        credenciais.username,
      );
    }
  }

  const comeca = new Date();

  /**
   * O prazo do PAINEL manda, e a nossa conta é o palpite de reserva.
   *
   * Ele devolve `expiresAt`, e é a data que vale: quem conta os dias é ele.
   * A nossa — começou agora, dura duas horas — dá quase sempre no mesmo
   * minuto e às vezes não, e a diferença aparece na única hora que importa:
   * o cliente tentando entrar no fim, com a nossa mensagem dizendo que ainda
   * dá tempo.
   */
  const expira = credenciais.expira_em
    ? new Date(credenciais.expira_em)
    : new Date(comeca.getTime() + horas * 3600_000);

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

  /**
   * # O texto: o da loja, senão o do painel, senão o nosso
   *
   * Estes robôs devolvem um `reply` completo — DNS, usuário, senha, lista
   * M3U e os códigos de TODOS os aplicativos parceiros —, porque é o que eles
   * mandam no site do revendedor. É por isso que colar o link já resolve:
   * sem cadastrar app nenhum e sem escrever texto nenhum, a mensagem sai
   * completa.
   *
   * A ordem é essa e não outra. Se a loja escreveu um texto para aquele app,
   * é porque ela quer o dela — sobrescrevê-la com o do painel seria a tela
   * de configuração não valendo nada. Sem texto próprio, o do painel é
   * melhor que o nosso padrão: ele conhece os apps parceiros dele e os
   * códigos de cada um, e nós não.
   */
  const texto = appConfig?.texto?.trim()
    ? renderizar(appConfig.texto, {
        username: credenciais.username,
        password: credenciais.password,
        codigo: appConfig?.codigo ?? undefined,
        dns: credenciais.dns,
        m3u_url: credenciais.m3u_url,
        lista_url: credenciais.lista_url,
        duracao: horas,
        expira: quando(expira.toISOString(), fuso),
        plano: credenciais.plano || pacote.name,
        telas: credenciais.telas ?? pacote.telas,
        nome: corpo.nome,
        codigos,
        comprado: false,
      })
    : (credenciais.reply?.trim() ||
      renderizar(TEXTO_PADRAO, {
        username: credenciais.username,
        password: credenciais.password,
        codigo: appConfig?.codigo ?? undefined,
        dns: credenciais.dns,
        m3u_url: credenciais.m3u_url,
        duracao: horas,
        expira: quando(expira.toISOString(), fuso),
        plano: credenciais.plano || pacote.name,
        telas: credenciais.telas ?? pacote.telas,
        nome: corpo.nome,
        codigos,
        comprado: false,
      }));

  const enviou = conversa ? await mandar(conversa, organizacao, texto) : false;

  return json({ ok: true, teste: teste.id, enviou, texto });
});
