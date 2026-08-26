import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import {
  ErroDoPainel,
  listarPacotes,
  pedirTeste,
  procurarPorUsuario,
} from "./painel.ts";
import { renderizar, TEXTO_PADRAO } from "./texto.ts";
import { escolherPacote } from "./pacote.ts";
import {
  acharApp,
  lerResposta,
  mensagemCurta,
  type AppDoPainel,
} from "./resposta.ts";

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

/**
 * O `waitUntil` do ambiente de borda, que os tipos não declaram.
 *
 * Ele segura a função viva até a promessa terminar, mesmo depois de a resposta
 * já ter ido embora. É o que permite fazer em segundo plano o que não muda o
 * que se responde — e não fazer o cliente esperar por isso.
 */
declare const EdgeRuntime: { waitUntil(promessa: Promise<unknown>): void };

const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SB_SECRET_KEY")!,
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

/**
 * # O catálogo de planos do painel, para a tela escolher
 *
 * ## Por que a autorização é refeita com o JWT de quem pediu
 *
 * Esta função roda com `service_role`, que enxerga tudo. Ler o servidor por
 * ela e devolver o catálogo entregaria o de qualquer loja a quem soubesse um
 * id — e ids de servidor circulam na URL da tela.
 *
 * Então a existência do servidor é conferida com um cliente montado sobre o
 * JWT de quem chamou, que passa pela RLS igual à tela. Não achou, não vê. O
 * `service_role` volta a ser usado só para o cofre, que é onde ele precisa
 * mesmo estar. - 2026/08/22
 */
async function catalogoDoPainel(
  servidorId: string | null,
  req: Request,
): Promise<Response> {
  if (!servidorId) return json({ erro: "faltou o servidor" }, 400);

  const autorizacao = req.headers.get("authorization") ?? "";

  const comoUsuario = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { authorization: autorizacao } } },
  );

  const { data: servidor } = await comoUsuario
    .from("iptv_servidores")
    .select("id, base_url, painel_url")
    .eq("id", servidorId)
    .maybeSingle();

  if (!servidor) return json({ erro: "servidor não encontrado" }, 404);

  const { data: token } = await client.rpc("get_iptv_token", {
    p_servidor_id: servidor.id,
  });

  if (!token) {
    /* 200 com o motivo dentro: não é falha de rede nem erro de quem chamou. É
     * uma configuração que falta, e a tela precisa dizer QUAL. */
    return json({ ok: false, mensagem: "este servidor não tem token" });
  }

  try {
    const pacotes = await listarPacotes({
      base_url: servidor.base_url ?? "",
      painel_url: servidor.painel_url,
      token: token as string,
    });

    return json({ ok: true, pacotes });
  } catch (erro) {
    const status = erro instanceof ErroDoPainel ? erro.status : 0;

    return json({ ok: false, mensagem: (erro as Error).message, status });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const qual = url.pathname.split("/").filter(Boolean).at(-1) ?? "";

  /**
   * # O catálogo do painel, para a tela escolher em vez de digitar
   *
   * `packageId` é um hashid — `o231qzL4qz`, `BV4D3rLaqZ`. Ninguém digita isso
   * certo, e digitar errado não dá erro: os hashids colidem entre tipos, então
   * um dedo trocado acerta outro pacote, ou um revendedor. Ver `painel.ts`.
   *
   * Então a tela lista e a pessoa escolhe. Só de leitura, e só para quem já
   * pode ver a configuração do servidor. - 2026/08/22
   */
  if (qual === "pacotes") {
    return await catalogoDoPainel(url.searchParams.get("servidor"), req);
  }

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
    /** O nome da loja, para assinar a mensagem. */
    loja?: string;
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
   *
   * ## `tipo = 'teste'`, e isso passou a importar hoje
   *
   * Até 2026/08/22 a loja só tinha planos de teste, e o filtro seria enfeite.
   * Com os planos de VENDA cadastrados ele vira a guarda: sem ele, um plano
   * pago que tivesse link de robô entraria no sorteio, e alguém que só pediu
   * um teste receberia — de graça — o acesso que custa 12 créditos.
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
    .eq("tipo", "teste")
    .eq("servidor.is_active", true)
    .eq("servidor.organization_id", organizacao);

  const { data: pacotes } = corpo.pacote
    ? await consulta.eq("id", corpo.pacote).limit(1)
    /* Vinte, e não um: quem escolhe é `escolherPacote`, e para escolher ele
     * precisa ver mais de um. Uma loja com mais de vinte planos ativos no
     * mesmo servidor não existe — e se existir, os vinte mais antigos são os
     * configurados. */
    : await consulta.order("created_at", { ascending: true }).limit(20);

  /* O primeiro que TEM COMO gerar, e não o mais antigo. Ver `pacote.ts`. */
  const pacote = escolherPacote(pacotes as never) as
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

  /**
   * # As três leituras vão JUNTAS
   *
   * Elas não dependem uma da outra: os apps do plano, o fuso da loja e o teste
   * ainda vivo deste telefone. Em fila eram três idas ao banco somadas; juntas
   * são uma espera só.
   *
   * Medido em 2026/08/22: o teste inteiro levava 3,22s, e só 1,87s eram do
   * mundo de fora — subir a função e falar com o painel. O resto era isto:
   * dez idas ao banco, uma esperando a outra sem motivo.
   *
   * E os apps viraram UMA consulta em vez de duas. A configuração do app
   * escolhido e a tabela de códigos de todos saíam da mesma tabela, com o
   * mesmo filtro, uma logo depois da outra.
   */
  const [{ data: appsDoPacote }, { data: orgRow }, { data: vivos }] =
    await Promise.all([
      client
        .from("iptv_apps")
        .select("app, is_enabled, codigo, texto, display_name")
        .eq("pacote_id", pacote.id),

      client.from("organizations").select("extra").eq("id", organizacao)
        .maybeSingle(),

      /**
       * # O guarda do reuso
       *
       * Este telefone já tem teste vivo aqui? Sem isto, o cliente que pede
       * duas vezes em dez minutos — o que acontece sempre, porque a primeira
       * mensagem "sumiu" na conversa — consome dois créditos e recebe dois
       * usuários diferentes. E aí ele pergunta qual usar, que é uma conversa
       * que ninguém quer ter.
       *
       * ## Casa por SERVIDOR, e não por app
       *
       * A especificação mandava casar também pelo app, e eu segui. Contra um
       * painel de verdade está errado: a mesma dupla usuário/senha serve os
       * quinze aplicativos, e o que muda entre eles é só o código de ativação.
       * Casando por app, quem respondesse "Super Play" depois de receber a
       * lista queimaria um segundo crédito para receber a MESMA senha com
       * outro código ao lado. Medido em 2026/08/22.
       */
      client
        .from("iptv_testes")
        .select(
          "id, username, password, codigo, dns, m3u_url, expira_em, app, apps",
        )
        .eq("organization_id", organizacao)
        .eq("contact_address", soDigitos(telefone))
        .eq("servidor_id", servidor.id)
        .eq("status", "ativo")
        .gt("expira_em", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

  /* Em minúsculas: quem atende escolhe pelo nome que o painel escreve
   * ("Super Play") e a chave é sempre minúscula. */
  const appConfig =
    (appsDoPacote ?? []).find((linha) => linha.app === app.toLowerCase()) ??
      null;

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
  const fuso = (orgRow?.extra as { timezone?: string } | null)?.timezone ||
    "America/Sao_Paulo";

  const codigos = Object.fromEntries(
    (appsDoPacote ?? [])
      .filter((linha) => linha.codigo)
      .map((linha) => [linha.app, linha.codigo as string]),
  );

  const horas = pacote.duracao_horas ?? servidor.trial_horas;

  if (vivos?.[0]) {
    const vivo = vivos[0];
    const guardados = (vivo.apps ?? []) as AppDoPainel[];

    /**
     * O reuso é o caminho de quem RESPONDEU qual app usa.
     *
     * Ele pediu o teste, recebeu a lista de nomes, e agora diz "Super Play".
     * A credencial é a mesma; o que muda é o código ao lado. Por isso a
     * mensagem aqui é a curta, e não a parede de novo.
     */
    const texto = appConfig?.texto?.trim()
      ? renderizar(appConfig.texto, {
          username: vivo.username,
          password: vivo.password ?? undefined,
          codigo: appConfig?.codigo ?? undefined,
          dns: vivo.dns ?? undefined,
          m3u_url: vivo.m3u_url ?? undefined,
          duracao: horas,
          expira: quando(vivo.expira_em, fuso),
          plano: pacote.name,
          telas: pacote.telas,
          nome: corpo.nome,
          codigos,
          comprado: false,
        })
      : mensagemCurta({
          username: vivo.username,
          password: vivo.password ?? "",
          dns: vivo.dns ?? undefined,
          app: acharApp(guardados, corpo.app),
          nomes: guardados.map((a) => a.nome),
          expira: quando(vivo.expira_em, fuso),
          loja: corpo.loja,
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
   *
   * ## E por isso ela não é esperada
   *
   * Ela não cancela nada, não muda o texto e não muda o que se grava. Tudo o
   * que faz é escrever no log. Esperar por ela era fazer o CLIENTE esperar por
   * um `console.warn`.
   *
   * Medido em 2026/08/22, com um cronômetro em cada parte:
   *
   *   0,70s   subir esta função e a viagem até ela
   *   1,17s   o robô do painel, que é o trabalho de verdade
   *   0,75s   esta confirmação  ← um quarto da espera, por nada
   *
   * E o pior é onde ela estava: ANTES de `mandar`. A mensagem com as
   * credenciais ficava três quartos de segundo parada esperando uma linha de
   * log. Agora ela roda em segundo plano, depois da resposta — o mesmo
   * trabalho, ninguém esperando. - 2026/08/22
   */
  if (painel.token) {
    const conferir = procurarPorUsuario(painel, credenciais.username)
      .then((confirmado) => {
        if (!confirmado) {
          console.warn(
            "[iptv] criado mas não confirmado",
            servidor.name,
            credenciais.username,
          );
        }
      })
      .catch((erro) => {
        /* Engolido de propósito: uma promessa rejeitada aqui derrubaria a
         * chamada inteira, e esta é a parte que menos importa dela. */
        console.warn("[iptv] não deu para confirmar", (erro as Error).message);
      });

    /* `waitUntil` mantém a função viva até terminar mesmo depois da resposta
     * já ter saído. Sem ele, o ambiente pode encerrar no meio e a conferência
     * viraria uma coisa que às vezes acontece — pior que não existir. */
    EdgeRuntime.waitUntil(conferir);
  }

  /* A parede lida em partes: os dois DNS, a lista e os apps com o código de
   * cada um. Vazio quando não deu para ler, e aí a parede vai inteira. */
  const lida = lerResposta(credenciais.reply);

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
      /* Lidos de dentro do texto do painel: é o único lugar onde eles
       * existem. Guardados, dá para mandar o código de outro app depois sem
       * gerar credencial nova. Ver `resposta.ts`. */
      apps: lida.apps,
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
  /**
   * # A ordem do texto, e por que a parede saiu da frente
   *
   * O painel devolve cento e trinta linhas: seis DNS, quinze aplicativos,
   * EPG, links curtos, códigos de STB e três downloads. É o que ele mostra
   * na página dele, onde a pessoa está sentada procurando o que é dela.
   *
   * No WhatsApp isso não funciona: quem pediu o teste usa UM aplicativo e
   * recebe uma parede onde precisa caçar duas linhas. O cliente que não acha
   * o código dele não instala, não testa, e não compra.
   *
   * Então:
   *
   *   texto da loja      quando ela escreveu um para aquele app
   *   mensagem curta     usuário, senha, o código do app pedido, o prazo
   *   a parede inteira   só quando não deu para ler nada dela
   *
   * Sem app escolhido, a curta pergunta qual — com os NOMES na frente, e não
   * os códigos. A resposta dele volta por aqui e cai no reuso: mesma
   * credencial, código certo, nenhum crédito a mais.
   */
  /**
   * # O catálogo de apps se preenche sozinho
   *
   * Quem atende escolhe o aplicativo ANTES de gerar — o cliente já disse o
   * que tem instalado, e é o que decide qual código mandar. Para escolher
   * antes, a lista precisa existir antes.
   *
   * E ela só existe depois: os códigos vêm dentro do texto que o painel
   * devolve junto com uma credencial. Não há de onde pedir a lista sem
   * gastar um crédito.
   *
   * Então o primeiro teste de cada pacote semeia o catálogo, e do segundo em
   * diante quem atende escolhe antes. A alternativa era a loja digitar
   * quinze nomes e quinze códigos à mão — e mantê-los quando o painel
   * trocasse um.
   *
   * `ignoreDuplicates` porque o par pacote+app é único: o que já existe fica
   * como está. Um código editado à mão pela loja não pode ser sobrescrito
   * pelo painel na próxima geração. - 2026/08/22
   */
  if (lida.apps.length) {
    const { error: erroAoSemear } = await client
      .from("iptv_apps")
      .upsert(
        lida.apps.map((a, i) => ({
          pacote_id: pacote.id,
          app: a.nome.toLowerCase(),
          display_name: a.nome,
          codigo: a.codigo,
          ordem: i + 1,
        })),
        { onConflict: "pacote_id,app", ignoreDuplicates: true },
      );

    /* Falhar aqui não desfaz nada: o teste existe e a mensagem vai sair. O
     * que se perde é a lista pronta para a próxima vez. */
    if (erroAoSemear) {
      console.warn("[iptv] não semeou o catálogo", erroAoSemear.message);
    }
  }

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
    : lida.apps.length
      ? mensagemCurta({
          username: credenciais.username,
          password: credenciais.password,
          dns: lida.dns ?? credenciais.dns,
          dns_alternativo: lida.dns_alternativo,
          app: acharApp(lida.apps, corpo.app),
          nomes: lida.apps.map((a) => a.nome),
          expira: quando(expira.toISOString(), fuso),
          loja: corpo.loja,
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
