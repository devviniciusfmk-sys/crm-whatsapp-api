/**
 * # Um por chave, e vale o último
 *
 * `upsert` de um lote que traz a mesma chave duas vezes não é "atualiza duas
 * vezes": o Postgres recusa o comando inteiro com *"ON CONFLICT DO UPDATE
 * command cannot affect row a second time"*. Uma linha repetida derruba as
 * outras quinhentas junto.
 *
 * Isso não é hipótese. Ao parear o primeiro número por `whatsapp-web` em
 * 2026/08/23, **todo** lote de histórico voltou 500 e nada entrou — nem uma
 * conversa, nem um grupo. A ponte reenviava, e reenviar não ajuda: o lote é
 * inválido por construção, não por azar. Isolado com duas sondas idênticas
 * exceto pela repetição — uma 200, a outra 500.
 *
 * Repetição no histórico é o NORMAL, não a exceção. O mesmo contato aparece
 * uma vez por mensagem que ele mandou; a mesma mensagem chega em dois pedaços
 * de sincronização que se sobrepõem. Um conector que só funciona com lote
 * limpo é um conector que não funciona.
 *
 * ## O último, e não o primeiro
 *
 * O lote vem em ordem cronológica, então a última ocorrência é a mais recente:
 * o apelido que a pessoa usa hoje, o status mais avançado da mensagem. Ficar
 * com o primeiro guardaria o nome de 2019.
 *
 * Um `Map` preserva a ordem de inserção da PRIMEIRA vez que a chave aparece,
 * e `set` sobrescreve o valor sem mover o lugar. Ou seja: sai na ordem em que
 * as chaves surgiram, com o conteúdo mais novo de cada uma — que é o que se
 * quer nos dois casos. - 2026/08/23
 */
export function ultimoDeCada<T>(
  linhas: T[],
  chave: (linha: T) => string | null | undefined,
): T[] {
  const porChave = new Map<string, T>();
  const semChave: T[] = [];

  for (const linha of linhas) {
    const k = chave(linha);

    /* Sem chave não há conflito possível, e agrupar tudo que é nulo sob a
     * mesma cesta apagaria linhas boas. Passam inteiras. */
    if (k === null || k === undefined || k === "") {
      semChave.push(linha);
      continue;
    }

    porChave.set(k, linha);
  }

  return [...porChave.values(), ...semChave];
}
