/**
 * # O texto que leva as credenciais até o cliente
 *
 * Cada aplicativo pede coisas diferentes: um quer usuário e senha, outro um
 * código de seis dígitos, outro a URL de uma lista M3U. Um texto único para
 * todos obrigaria a mandar os campos de todos, e o cliente receberia três
 * linhas que não servem para ele — no meio das duas que servem.
 *
 * Daí um texto por app, com buracos para preencher.
 *
 * ## Por que uma mini-linguagem, e por que ela é minúscula
 *
 * Ela tem exatamente duas construções: `{campo}` e `{#teste}…{/teste}`. Nada
 * de laços, de condição sobre valor, de aritmética. Cada construção a mais é
 * uma dúvida a mais para quem escreve o texto — e quem escreve é o dono da
 * loja, não um programador.
 *
 * A tentação de reaproveitar o formato de modelos da Meta (`{{1}}`) não
 * resolve: lá os buracos são numerados porque a Meta exige, e um texto com
 * `{{1}} {{2}} {{3}}` é ilegível para quem vai mantê-lo.
 *
 * ## O bloco condicional existe por um motivo caro
 *
 * O MESMO texto serve para o teste de duas horas e para o acesso comprado. Sem
 * o bloco, ou a loja mantém dois textos por app — e o segundo fica
 * desatualizado — ou o cliente que comprou o plano anual recebe "Duração: 2
 * horas" logo abaixo do que acabou de pagar.
 *
 * ## O que ele NÃO faz
 *
 * Não inventa valor. Buraco sem dado vira string vazia, e não o nome do campo:
 * um `{codigo}` cru no meio da mensagem é a loja mostrando o próprio molde ao
 * cliente. - 2026/08/22
 */

export type DadosDoTexto = {
  username?: string;
  password?: string;
  /** O código de ativação do app, quando ele usa um. */
  codigo?: string;
  dns?: string;
  m3u_url?: string;
  lista_url?: string;
  /** Em horas. Só faz sentido no teste. */
  duracao?: number;
  /** Já formatada para leitura: "25/12/2026 às 18:30". */
  expira?: string;
  plano?: string;
  telas?: number;
  nome?: string;
  /**
   * Os códigos de TODOS os apps do pacote, por nome.
   *
   * Existe para `{vizzion_codigo}` funcionar dentro do texto do XCIPTV — que é
   * o caso de quem manda um texto só listando onde assistir. Sem isso, cada
   * texto só conseguiria falar do próprio app.
   */
  codigos?: Record<string, string>;
  /**
   * `false` é teste, `true` é acesso comprado.
   *
   * Decide os blocos condicionais, e nada mais. Não muda campo nenhum: quem
   * quiser um texto diferente escreve o texto diferente dentro do bloco.
   */
  comprado?: boolean;
};

/** Buraco sem dado é vazio, e nunca o nome do buraco. */
const ou = (valor: string | number | undefined | null) =>
  valor === undefined || valor === null ? "" : String(valor);

export function renderizar(molde: string, dados: DadosDoTexto): string {
  const comprado = dados.comprado ?? false;

  let saida = molde;

  /* Os blocos primeiro: sem isso, um `{duracao}` dentro de um bloco de teste
   * seria substituído e só depois descartado — trabalho à toa, e pior, um
   * `{/teste}` no meio de um valor quebraria o descarte. */
  saida = saida.replace(
    /\{#teste\}([\s\S]*?)\{\/teste\}/g,
    (_, dentro: string) => (comprado ? "" : dentro),
  );

  saida = saida.replace(
    /\{#pago\}([\s\S]*?)\{\/pago\}/g,
    (_, dentro: string) => (comprado ? dentro : ""),
  );

  /* `{<app>_codigo}` antes dos campos fixos: `{codigo}` sozinho é o do app
   * atual, e `{vizzion_codigo}` é o de outro. Na ordem inversa, o segundo
   * nunca casaria — o primeiro já teria comido o sufixo. */
  const codigos = dados.codigos ?? {};

  saida = saida.replace(
    /\{([a-z0-9_]+)_codigo\}/gi,
    (_, app: string) => codigos[app.toLowerCase()] ?? "",
  );

  const campos: Record<string, string> = {
    usuario: ou(dados.username),
    username: ou(dados.username),
    senha: ou(dados.password),
    password: ou(dados.password),
    codigo: ou(dados.codigo),
    dns: ou(dados.dns),
    m3u: ou(dados.m3u_url),
    lista: ou(dados.lista_url),
    duracao: ou(dados.duracao),
    expira: ou(dados.expira),
    plano: ou(dados.plano),
    telas: ou(dados.telas),
    nome: ou(dados.nome),
  };

  saida = saida.replace(
    /\{([a-z0-9_]+)\}/gi,
    (inteiro, campo: string) =>
      campo.toLowerCase() in campos ? campos[campo.toLowerCase()] : inteiro,
  );

  /**
   * As linhas que ficaram vazias somem.
   *
   * Um bloco condicional descartado deixa uma linha em branco no lugar, e três
   * blocos deixam três — a mensagem chega com buracos no meio. Isto tira o
   * excesso e mantém no máximo uma linha em branco seguida, que é o que separa
   * parágrafos.
   */
  return saida.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * O texto padrão, para quem não escreveu um.
 *
 * Existe porque a primeira credencial precisa sair antes de alguém abrir a
 * tela de configurar textos — e porque uma loja com quatro apps não vai
 * escrever quatro textos no primeiro dia.
 *
 * Só campos que todo app tem. Código e DNS ficam de fora de propósito: eles
 * são de alguns, e um "DNS:" vazio na mensagem é pior que a ausência dele.
 */
export const TEXTO_PADRAO = [
  "{#teste}🎁 *Seu teste está pronto!*{/teste}",
  "{#pago}✅ *Acesso liberado!*{/pago}",
  "",
  "👤 *Usuário:* {usuario}",
  "🔑 *Senha:* {senha}",
  "",
  "{#teste}⏰ *Vale por:* {duracao} horas",
  "📅 *Até:* {expira}{/teste}",
  "{#pago}📺 *Plano:* {plano}{/pago}",
  "",
  "Qualquer dúvida é só chamar!",
].join("\n");
