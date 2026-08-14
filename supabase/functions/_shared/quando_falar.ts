/**
 * # "Me chama às 19" — lido sem modelo
 *
 * Quando um humano está atendendo, a assistente cala a boca: o gatilho
 * `pause_conversation_on_human_message` pausa a conversa por 12 horas para o
 * robô não atropelar quem digitou. A regra é boa e tem um preço que ninguém
 * enxerga — calada, ela também não chama a ferramenta que marcaria o retorno.
 * O cliente diz "me chama às 19", o dono responde "combinado" com a tesoura na
 * mão, e às 19 não sai nada.
 *
 * Isto lê a hora e devolve uma SUGESTÃO. Nada sai daqui: quem decide é o dono,
 * num toque, com a hora à vista.
 *
 * ## Por que não perguntar ao modelo
 *
 * Duas razões, e a segunda é a que decide.
 *
 * A primeira é custo e alcance: uma chamada de modelo por mensagem recebida em
 * conversa pausada é gasto contínuo pelo que quase sempre é "nada a marcar".
 * E a chamada barata — o jeito do `contact-memory` — só funciona para agente
 * com endereço e chave próprios; quem usa a chave da plataforma passa pela
 * contabilidade de créditos, que mora dentro do protocolo. O recurso ficaria
 * desligado em silêncio justamente no piloto.
 *
 * A segunda: ler "19h" de um texto é aritmética, não julgamento. Toda decisão
 * que este projeto deixou para o modelo voltou como defeito — a conta da
 * comissão, a escolha de qual porta fechar — e a correção sempre foi a mesma,
 * tirar a decisão de lá. Uma tabela de padrões erra igual todo dia, e o dia em
 * que ela errar dá para consertar com um teste.
 *
 * O que torna isso aceitável aqui é a sugestão ser confirmada: um falso
 * positivo custa um aviso que o dono ignora, e um falso negativo custa o botão
 * que ele já tinha. Nenhum dos dois manda mensagem para ninguém.
 *
 * ## Só hoje e amanhã
 *
 * Fora disso a mensagem cairia fora da janela de 24 horas e precisaria de
 * modelo aprovado, com variável, custo e categoria — o modal inteiro. Um chip
 * de um toque não tem onde dizer isso, e um toque que abre uma decisão de
 * dinheiro seria pior que não existir. "Semana que vem" sai daqui sem sugestão
 * nenhuma, e o botão de agendar continua onde sempre esteve.
 *
 * Português só, por enquanto: acrescentar um idioma é acrescentar as tabelas
 * dele, e o piloto é no Brasil. - 2026/08/13
 */

export type HoraPedida = {
  /** Hora local do estabelecimento, 0–23. */
  hora: number;
  minuto: number;
  /** Se cai no dia seguinte ao da mensagem. */
  amanha: boolean;
  /** O pedaço do texto que foi lido, para o log e para os testes. */
  trecho: string;
};

/**
 * Minúsculas e sem acento, para as tabelas abaixo não precisarem de duas
 * grafias de cada palavra. `\p{M}` e não a faixa `̀-ͯ` escrita à mão:
 * a faixa em literal deixa caracteres combinantes invisíveis no meio do código,
 * que um editor descuidado come sem avisar.
 */
const normalizar = (texto: string) =>
  texto.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Ele PEDIU contato. É o sinal forte, e vence até quando a frase também fala
 * em marcar — "me chama às 19 pra gente marcar" é um pedido de retorno que por
 * acaso menciona a agenda.
 */
const PEDIDO =
  /\bme\s+(chama|chame|chamar|liga|ligue|ligar|manda|mande|mandar|procura|procure|avisa|avise|responde|responda|retorna|retorne)\b|\b(pode|podes|poderia|consegue)\s+(me\s+)?(chamar|ligar|mandar|retornar)\b|\bentrar?\s+em\s+contato\b|\bretorna?r?\s+(mais\s+tarde|depois)\b/;

/**
 * Ele disse QUANDO pode, sem pedir nada. É o sinal fraco — e é a forma mais
 * comum na vida real, que foi justamente o caso que faltava quando só se olhava
 * para o verbo "chamar".
 */
const INDISPONIVEL =
  /\bnao\s+(posso|consigo|da\s+pra|vou\s+poder)\s+(falar|atender|conversar|responder|ver)\b|\b(to|tou|estou)\s+(ocupad|trabalhando|dirigindo|na\s+rua|no\s+trabalho|em\s+reuniao|em\s+servico)|\bso\s+(posso|consigo|vou\s+poder|depois|quando|as)\b|\bquando\s+(eu\s+)?(chegar|sair|acabar|terminar)\b|\bmais\s+tarde\b|\bdepois\s+das?\b|\bagora\s+(nao|to|tou|estou)\b/;

/**
 * Marcar corte é outra coisa. Quem quer horário usa a agenda, e sugerir um
 * retorno ali seria oferecer a ferramenta errada para um pedido claro.
 *
 * Só desqualifica quando NÃO houve pedido direto de contato — ver `PEDIDO`.
 */
const MARCACAO =
  /\b(marcar|marca\s+(pra|para)|agendar|agendamento|tem\s+vaga|tem\s+horario|quero\s+cortar|encaixe|encaixar|da\s+pra\s+atender)\b/;

/**
 * Passou de amanhã, some a sugestão.
 *
 * `depois de amanha` está aqui de propósito e é testado: ele contém "amanha", e
 * sem esta linha seria lido como o dia seguinte — a sugestão sairia com dois
 * dias de erro e o dono confirmaria sem reparar, porque o chip mostra a hora.
 */
const OUTRO_DIA =
  /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|semana\s+que\s+vem|proxima\s+semana|depois\s+de\s+amanha|daqui\s+a\s+\w+\s+(dias?|semanas?|meses)|mes\s+que\s+vem|dia\s+\d{1,2})\b/;

/**
 * O período dito, e nunca o cumprimento.
 *
 * Exige `da/de/pela/à` na frente: "boa noite, me chama às 7" às nove da noite
 * quer dizer sete da MANHÃ, e casar o "noite" do cumprimento jogaria para as
 * 19h de um dia que já passou.
 */
const PERIODO = /\b(?:da|de|pela|a)\s+(manha|tarde|noite|madrugada)\b/;

/** "daqui a duas horas" — relativo, e lido antes do relógio para não virar 2h. */
const DAQUI =
  /\bdaqui\s+(?:a\s+)?(uma?|dois|duas|meia|\d{1,2})\s*(hora|minuto)/;

const NUMERO_ESCRITO: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  meia: 0.5,
};

/**
 * As formas de escrever uma hora, da mais específica para a mais solta.
 *
 * A ordem é o que separa "19h30" de "19h": o primeiro padrão exige os minutos,
 * então quem não os tem cai no segundo. Invertê-los faria toda hora com minuto
 * perder o minuto, e o cliente receberia a mensagem meia hora antes.
 */
const RELOGIO: { re: RegExp; comMinuto?: boolean }[] = [
  // 19:30 · 19h30 · 19 h 30
  { re: /\b(\d{1,2})\s*[:h]\s*(\d{2})\b/, comMinuto: true },
  // 19h · 19hs · 19 horas
  { re: /\b(\d{1,2})\s*(?:h\b|hs\b|hrs\b|horas?\b)/ },
  // às 19 · depois das 19 · por volta das 19 · umas 19
  {
    re:
      /\b(?:as|ate|apos|depois\s+das?|pelas?|por\s+volta\s+das?|umas?|la\s+pelas?)\s+(\d{1,2})\b/,
  },
  // 7 da noite
  { re: /\b(\d{1,2})\s+(?:da|de)\s+(?:manha|tarde|noite|madrugada)\b/ },
];

type Agora = { hora: number; minuto: number };

/** Minutos desde a meia-noite. */
const emMinutos = (hora: number, minuto: number) => hora * 60 + minuto;

/**
 * Lê a hora que o cliente pediu, ou nada.
 *
 * `agora` é a hora LOCAL do estabelecimento, e é parâmetro em vez de relógio de
 * dentro para o teste poder fixá-la: metade das regras aqui depende de que
 * horas são, e um teste que não controla isso passa de manhã e falha à noite.
 */
export function quandoFalar(texto: string, agora: Agora): HoraPedida | null {
  const t = normalizar(texto);

  if (OUTRO_DIA.test(t)) return null;

  const pediu = PEDIDO.test(t);

  if (!pediu && !INDISPONIVEL.test(t)) return null;
  if (!pediu && MARCACAO.test(t)) return null;

  const amanhaDito = /\bamanha\b/.test(t);

  // "daqui a duas horas" vem antes: sem isto, o "2 horas" cairia no relógio e
  // viraria duas da tarde.
  const relativo = DAQUI.exec(t);

  if (relativo) {
    const quantidade = NUMERO_ESCRITO[relativo[1]] ?? Number(relativo[1]);
    const somar = relativo[2] === "hora" ? quantidade * 60 : quantidade;
    const alvo = emMinutos(agora.hora, agora.minuto) + somar;

    return {
      hora: Math.floor((alvo % 1440) / 60),
      minuto: Math.round(alvo % 60),
      amanha: alvo >= 1440,
      trecho: relativo[0],
    };
  }

  if (/\bmeio\s*-?\s*dia\b/.test(t)) {
    return fechar(12, 0, amanhaDito, agora, "meio-dia");
  }

  if (/\bmeia\s*-?\s*noite\b/.test(t)) {
    return { hora: 0, minuto: 0, amanha: true, trecho: "meia-noite" };
  }

  for (const padrao of RELOGIO) {
    const achado = padrao.re.exec(t);

    if (!achado) continue;

    const hora = Number(achado[1]);
    const minuto = padrao.comMinuto ? Number(achado[2]) : 0;

    if (!Number.isFinite(hora) || hora > 23 || minuto > 59) continue;

    const periodo = PERIODO.exec(t)?.[1];

    if (periodo) {
      let h = hora;

      if ((periodo === "tarde" || periodo === "noite") && h < 12) h += 12;
      if (periodo === "madrugada" && h === 12) h = 0;

      return fechar(h, minuto, amanhaDito, agora, achado[0]);
    }

    if (hora > 12) return fechar(hora, minuto, amanhaDito, agora, achado[0]);

    /**
     * Doze horas são ambíguas, e a leitura certa é a PRÓXIMA que chegar.
     *
     * "Me chama às 7" às duas da tarde é sete da noite; a mesma frase às nove
     * da noite é sete da manhã. É como uma pessoa lê, e não precisa de tabela
     * de bom senso sobre a que horas barbeiro atende.
     */
    if (amanhaDito) {
      // Com "amanhã" não há próxima ocorrência para procurar: o dia é outro.
      // De uma às seis ninguém quer dizer madrugada.
      return {
        hora: hora >= 1 && hora <= 6 ? hora + 12 : hora,
        minuto,
        amanha: true,
        trecho: achado[0],
      };
    }

    const agoraMin = emMinutos(agora.hora, agora.minuto);
    const cedo = emMinutos(hora, minuto);
    const tarde = emMinutos(hora === 12 ? 12 : hora + 12, minuto);

    if (cedo > agoraMin) {
      return { hora, minuto, amanha: false, trecho: achado[0] };
    }

    if (tarde > agoraMin && hora !== 12) {
      return { hora: hora + 12, minuto, amanha: false, trecho: achado[0] };
    }

    return { hora, minuto, amanha: true, trecho: achado[0] };
  }

  return null;
}

/** Hora sem ambiguidade: só falta saber se ainda cabe hoje. */
function fechar(
  hora: number,
  minuto: number,
  amanhaDito: boolean,
  agora: Agora,
  trecho: string,
): HoraPedida {
  const passou = emMinutos(hora, minuto) <= emMinutos(agora.hora, agora.minuto);

  return { hora, minuto, amanha: amanhaDito || passou, trecho };
}
