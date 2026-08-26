import type { Json } from "./db_types.ts";

/**
 * # Tradutor entre o conector novo e este servidor
 *
 * O upstream refez o endereçamento dos conectores: uma mensagem passou a dizer
 * `conversation_address` (o chat) e `sender_address` (quem falou), no lugar de
 * `contact_address` + `group_address` + `direction`. A ponte `whatsapp-web` já
 * fala o contrato novo; este servidor ainda guarda o antigo, e a diferença
 * aparece do pior jeito possível:
 *
 *   {"conversation_address":"555391424424","sender_address":"555381062741", …}
 *
 * O webhook lia `contact_address` — ausente —, lia `direction` — ausente, logo
 * "outgoing" — e inseria uma mensagem sem endereço nenhum. A conversa não
 * podia ser resolvida e o insert estourava. **Todo** lote de pareamento voltou
 * 500 em 2026/08/23; nem uma conversa entrou. O erro não dizia nada: só
 * "Internal Server Error", com a causa do outro lado do túnel. Foi preciso pôr
 * um proxy no meio para ver o que a ponte mandava de verdade.
 *
 * ## Por que traduzir, e não migrar
 *
 * Adotar o contrato novo de verdade é mudar a coluna que a caixa de entrada, as
 * campanhas, o assistente e o despachante leem — um refactor do produto
 * inteiro. Traduzir é uma função pura na borda, e a borda é onde diferença de
 * versão deve morrer.
 *
 * O caminho contrário — travar a ponte numa versão velha — custa mais do que
 * parece: são 18 commits depois da quebra, entre eles o backend SQLite (sem
 * ele a ponte exige um Postgres emprestado) e as correções de pareamento.
 *
 * Isto é dívida, e é dívida datada: no dia em que este servidor adotar o
 * endereçamento novo, este arquivo some inteiro. - 2026/08/23
 */

/** O que chega, em qualquer um dos dois contratos. */
export type MensagemDoConector = {
  external_id: string;
  content: Json;
  timestamp: string;
  status?: Record<string, Json>;
  thread_id?: string;
  /* contrato antigo */
  direction?: "incoming" | "outgoing";
  contact_address?: string;
  group_address?: string;
  /* contrato novo */
  conversation_address?: string;
  sender_address?: string;
};

export type StatusDoConector = {
  external_id: string;
  status: Record<string, Json>;
  contact_address?: string;
  group_address?: string;
  conversation_address?: string;
};

/** Um chat de grupo se reconhece pelo sufixo do JID, e só por ele. */
export const ehGrupo = (endereco?: string) => !!endereco?.endsWith("@g.us");

/**
 * Quem falou, lido do `external_id`.
 *
 * O conector monta o identificador como `wmw.<minha>.<chat>.<quem>.<id>`, e o
 * README dele diz para que serve: "the sender segment encodes direction
 * (sender == own) and the group participant". A autoria está escrita na chave.
 *
 * Existe porque `sender_address` NÃO vem nos lotes de histórico. A primeira
 * versão desta tradução tratava remetente ausente como "foi a própria loja", e
 * o resultado foi medido em 2026/08/24: um grupo de revenda onde 75 pessoas
 * diferentes falaram teve 867 das suas 877 mensagens marcadas como saídas da
 * loja. Quatro eram de verdade.
 *
 * O estrago não é cosmético. `direction` é a coluna que decide quem respondeu
 * quem, quantas conversas ficaram sem resposta e o que a caixa chama de
 * "pendentes". E ela erra calada: nada estoura, os números só ficam errados.
 *
 * Só é consultado quando `sender_address` falta — quem manda o campo continua
 * mandando a verdade mais direta. - 2026/08/24
 */
export function remetenteDoId(externalId?: string): string | undefined {
  const partes = (externalId ?? "").split(".");

  /**
   * Cinco segmentos OU MAIS, e não exatamente cinco.
   *
   * A primeira versão exigia cinco em ponto. O `ids.go` da própria ponte usa
   * `SplitN(ext, ".", 5)` com o comentário dizendo por quê: "the message ID may
   * itself contain dots". Um id assim tem seis pedaços ou mais, e a regra
   * antiga o recusaria — devolvendo "não sei quem falou" justamente para a
   * mensagem que carrega a resposta.
   *
   * Hoje não há nenhuma dessas nos mil registros que chegaram, então isto não
   * consertou nada visível. Foi escrito porque o parser do outro lado diz que
   * o caso existe, e uma regra que contradiz o formato que ela lê está errada
   * mesmo enquanto ninguém a exercita.
   *
   * O prefixo continua obrigatório: `wamid.…` da API oficial tem outro
   * significado em cada posição, e ler o quarto pedaço dele seria inventar.
   */
  if (partes.length < 5 || partes[0] !== "wmw") return undefined;

  return partes[3] || undefined;
}

/**
 * A mensagem no formato que este servidor grava.
 *
 * Quem já fala o contrato antigo passa INTEIRO, sem tradução: `direction`
 * presente é a assinatura dele. Sem isso, o conector do Instagram — que nunca
 * mandou `conversation_address` — seria reescrito por um tradutor que não é
 * para ele.
 */
export function traduzirMensagem(
  mensagem: MensagemDoConector,
  organizationAddress: string,
): MensagemDoConector {
  if (mensagem.direction) return mensagem;

  const chat = mensagem.conversation_address;

  if (!chat) return mensagem;

  const { conversation_address: _, sender_address, ...resto } = mensagem;

  /**
   * Quem falou decide a direção — e o campo nem sempre vem.
   *
   * A ponte carimba o próprio número quando a conta falou (desde
   * `feat(sender): stamp the session's own number on IsFromMe`), então
   * `sender_address === organizationAddress` é saída. Mas no histórico o campo
   * não vem de jeito nenhum, e é aí que o `external_id` responde.
   *
   * Ausente nos DOIS é o único caso que ainda vira saída: sem nada que diga o
   * contrário, a leitura do contrato vale ("vazio quando a própria conta
   * falou").
   */
  const quem = sender_address || remetenteDoId(mensagem.external_id);
  const daCasa = !quem || quem === organizationAddress;

  if (ehGrupo(chat)) {
    return {
      ...resto,
      direction: daCasa ? "outgoing" : "incoming",
      group_address: chat,
      /* Em grupo, o contato é o participante — e não há participante quando
       * quem falou foi a própria loja. */
      contact_address: daCasa ? undefined : quem,
    };
  }

  return {
    ...resto,
    direction: daCasa ? "outgoing" : "incoming",
    /* Em conversa de duas pessoas o contato é sempre O OUTRO, inclusive
     * quando quem escreveu foi a loja: `sender_address` seria o número da
     * própria loja, e a mensagem cairia numa conversa consigo mesma. */
    contact_address: chat,
  };
}

/** O recibo, pelas mesmas regras — mas recibo não tem direção. */
export function traduzirStatus(status: StatusDoConector): StatusDoConector {
  const chat = status.conversation_address;

  if (!chat || status.contact_address || status.group_address) return status;

  const { conversation_address: _, ...resto } = status;

  return ehGrupo(chat)
    ? { ...resto, group_address: chat }
    : { ...resto, contact_address: chat };
}

/**
 * # Os nomes, que no contrato novo viajam na mensagem
 *
 * Antes, quem falava era nomeado por duas listas do lote: `contacts[]` para o
 * apelido de perfil, `groups[]` para o assunto do grupo. O contrato novo
 * carimba `sender_name` e `conversation_name` em CADA mensagem e não manda
 * mais as listas.
 *
 * Traduzir só o endereçamento fez a caixa de entrada encher de número: três
 * conversas, todas "(sem nome)", com os nomes ali no payload sendo jogados
 * fora. É o sintoma que este projeto já catalogou uma vez — "o cliente aparece
 * como telefone" — chegando por uma porta nova.
 *
 * Então as listas voltam a existir, montadas a partir das mensagens. É
 * tradução, e não invenção: cada nome sai de um campo que veio no fio.
 *
 * ## Em conversa de duas pessoas, o nome do chat é o nome do OUTRO
 *
 * E vale principalmente na mensagem que a loja mandou: ali `sender_name` está
 * ausente (a conta não precisa se nomear) e `conversation_name` é justamente
 * quem se quer nomear. Sem este caso, um cliente que só recebeu mensagens
 * nossas ficaria para sempre como número. - 2026/08/23
 */
export function nomesDoLote(
  mensagens: Array<
    MensagemDoConector & {
      sender_name?: string;
      conversation_name?: string;
    }
  >,
): {
  contatos: Array<{ address: string; extra: { name: string } }>;
  grupos: Array<{ address: string; name: string }>;
} {
  const contatos = new Map<string, { address: string; extra: { name: string } }>();
  const grupos = new Map<string, { address: string; name: string }>();

  for (const mensagem of mensagens) {
    const chat = mensagem.conversation_address;
    const nomeDoChat = mensagem.conversation_name?.trim();
    const quem = mensagem.sender_address;
    const nomeDeQuem = mensagem.sender_name?.trim();

    if (quem && nomeDeQuem) {
      contatos.set(quem, { address: quem, extra: { name: nomeDeQuem } });
    }

    if (!chat || !nomeDoChat) continue;

    if (ehGrupo(chat)) {
      grupos.set(chat, { address: chat, name: nomeDoChat });
    } else {
      /* Não sobrescreve o apelido que veio de `sender_name` para a mesma
       * pessoa: aquele é como ELA se chama, este é como ESTE aparelho a
       * chama. Quando os dois existem, o da agenda já ganhou acima. */
      if (!contatos.has(chat)) {
        contatos.set(chat, { address: chat, extra: { name: nomeDoChat } });
      }
    }
  }

  return { contatos: [...contatos.values()], grupos: [...grupos.values()] };
}
