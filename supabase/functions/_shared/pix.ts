/**
 * # O "copia e cola" do Pix
 *
 * ESPELHO de `open-bsp-ui/src/utils/pix.ts`, e tem de continuar idêntico: a
 * tela monta o código quando alguém toca "cobrar", e este arquivo monta quando
 * o gatilho dispara sozinho. Duas versões que divergem viram dois códigos
 * diferentes para a mesma loja, e quem descobre é o cliente com o banco
 * recusando. Os casos de conferência vivem em `scripts/pix-copia-e-cola.mjs`,
 * do lado da tela.
 *
 * O BR Code é EMV: campos em ID + tamanho + valor, o tamanho sempre com dois
 * dígitos, e um deles (o 26) com campos aninhados dentro.
 *
 * O detalhe que quebra quase toda implementação da internet está no fim: o
 * literal `6304` ENTRA no cálculo do CRC. Quem calcula sobre o texto sem o
 * campo 63 e depois cola `6304XXXX` gera um código que às vezes um aplicativo
 * lê por acaso — até alguém mudar um caractere e ninguém entender por quê.
 *
 * Conferido contra dois casos publicados, e não contra o meu próprio código:
 * o exemplo oficial do BACEN (`63041D3D`) e um segundo com valor
 * (`6304BB4A`). Mais o valor de conferência universal do algoritmo, que é o
 * CRC de "123456789" dar 0x29B1 — esse não tem nada a ver com Pix e prova que
 * a conta em si está certa. Veja `scripts/pix-copia-e-cola.mjs`.
 *
 * Isto gera um código ESTÁTICO com valor: qualquer banco lê, ninguém precisa
 * de gateway, e o dinheiro cai direto na conta da loja. O que ele não tem é
 * aviso de pagamento — quem confere que caiu é a pessoa. Para confirmação
 * automática é preciso um PSP emitindo cobrança dinâmica, e aí o código muda
 * de forma mas esta função continua servindo de base. - 2026/08/18
 */

/**
 * Se um texto carrega algo com cara de código Pix.
 *
 * Serve para BARRAR: o assistente não pode escrever código de pagamento, e um
 * inventado por ele tem a mesma cara de um verdadeiro. Ver `agent-client`.
 *
 * Procura o identificador do arranjo (`br.gov.bcb.pix`), que todo BR Code
 * carrega e que nenhuma frase de atendimento contém por acaso. Frouxo de
 * propósito quanto a maiúsculas e ao resto do payload: um código PELA METADE
 * — que foi o caso do modelo que estourou o limite no meio — também tem de ser
 * barrado.
 *
 * Divergência consciente do espelho da tela: esta função só existe aqui,
 * porque só aqui há um modelo escrevendo texto. - 2026/08/19
 */
export function pareceCodigoPix(texto: string): boolean {
  return /br\.gov\.bcb\.pix/i.test(texto);
}

/** CRC-16/CCITT-FALSE: polinômio 0x1021, início 0xFFFF, sem reflexão. */
export function crc16(texto: string): string {
  let crc = 0xffff;

  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;

    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Um campo EMV: o id, o tamanho com dois dígitos, e o valor. */
const campo = (id: string, valor: string) =>
  `${id}${String(valor.length).padStart(2, "0")}${valor}`;

/**
 * Sem acento e dentro do limite.
 *
 * O padrão manda caracteres do alfabeto latino básico, e o limite não é
 * decoração: nome com mais de 25 ou cidade com mais de 15 faz aplicativo de
 * banco recusar o código inteiro, sem dizer qual campo.
 */
const limpar = (texto: string, limite: number) =>
  texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, limite);

export type CobrancaPix = {
  /** A chave: CPF/CNPJ, telefone, e-mail ou aleatória. */
  chave: string;
  /** Quem recebe, como aparece no aplicativo de quem paga. Até 25. */
  nome: string;
  /** A cidade de quem recebe. Até 15. */
  cidade: string;
  /** Em reais. Sem valor, quem paga digita quanto quiser. */
  valor?: number;
  /**
   * O identificador da cobrança, até 25 caracteres sem espaço. Volta no extrato
   * de quem recebe, e é por ele que se sabe qual cobrança foi paga.
   */
  txid?: string;
};

export function codigoPix(
  { chave, nome, cidade, valor, txid }: CobrancaPix,
): string {
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", chave);

  const partes = [
    campo("00", "01"),
    campo("26", conta),
    campo("52", "0000"),
    campo("53", "986"),
    valor !== undefined ? campo("54", valor.toFixed(2)) : "",
    campo("58", "BR"),
    campo("59", limpar(nome, 25)),
    campo("60", limpar(cidade, 15)),
    // O `***` do padrão quer dizer "sem identificador", e não é um valor vazio:
    // campo 05 ausente e campo 05 com `***` são coisas diferentes para o banco.
    campo("62", campo("05", txid ? limpar(txid, 25) : "***")),
  ].join("");

  const semCrc = `${partes}6304`;

  return semCrc + crc16(semCrc);
}

/**
 * A cobrança de uma loja, ou nada quando falta o que o padrão exige.
 *
 * Existe para que a tela de configuração e o botão da conversa montem o código
 * pelo MESMO caminho. Duas derivações do que é "o nome" e "a cidade" da loja
 * viram, mais cedo ou mais tarde, dois códigos diferentes para a mesma loja —
 * e quem descobre é o cliente, com o banco recusando.
 *
 * Devolve `null` em vez de um código pela metade: cobrança incompleta é pior
 * que cobrança nenhuma, porque parece que funcionou.
 */
export function cobrancaDaLoja(
  loja: { nome?: string; chave?: string; cidade?: string },
  valor?: number,
  txid?: string,
): string | null {
  if (!loja.chave?.trim() || !loja.nome?.trim()) return null;

  return codigoPix({
    chave: loja.chave.trim(),
    nome: loja.nome,
    cidade: loja.cidade?.trim() || CIDADE_QUANDO_NAO_SE_SABE,
    valor,
    txid,
  });
}

/**
 * A cidade quando a loja não cadastrou endereço.
 *
 * O campo 60 é exigido pelo padrão e ninguém confere o que vai nele — nenhum
 * banco valida a cidade contra coisa alguma. Então incluir com um valor
 * genérico é estritamente mais seguro que omitir: um aplicativo rigoroso
 * recusa a ausência, e nenhum recusa o conteúdo.
 *
 * Por isso deixou de ser pergunta. Cobrar de quem cadastra o preço de uma
 * exigência que ninguém verifica é fazer a pessoa trabalhar para o padrão em
 * vez do contrário. Quem tem endereço cadastrado vê a própria cidade; quem
 * não tem, vê esta. - 2026/08/18
 */
export const CIDADE_QUANDO_NAO_SE_SABE = "BRASIL";
