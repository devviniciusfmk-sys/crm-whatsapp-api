/**
 * # Devolver a autoria às mensagens que entraram como se fossem da loja
 *
 * A tradução do contrato novo do conector lia "sem `sender_address`" como "foi
 * a própria conta que falou". É o que o contrato diz — e não vale para os lotes
 * de HISTÓRICO, onde o campo simplesmente não vem.
 *
 * Medido em 2026/08/24, na primeira sincronização: um grupo de revenda em que
 * 75 pessoas diferentes falaram teve 867 das suas 877 mensagens gravadas como
 * saídas da loja, sem contato nenhum. Quatro eram de verdade.
 *
 * `direction` não é enfeite: é a coluna que decide quem respondeu quem, o que
 * a caixa de entrada chama de "pendente", e quantas conversas ficaram sem
 * resposta. Deixá-la errada não estoura nada — só faz todo número construído
 * em cima dela mentir.
 *
 * ## De onde sai a verdade
 *
 * Do próprio identificador. O conector monta `wmw.<minha>.<chat>.<quem>.<id>`,
 * e o README dele descreve o quarto segmento como o que "encodes direction
 * (sender == own) and the group participant". A autoria estava gravada o tempo
 * todo, ao lado da linha errada.
 *
 * `split_part` e não regex: o formato é fixo e separado por ponto, e nenhum dos
 * segmentos contém ponto — o chat é o JID sem sufixo, o id é hexadecimal.
 *
 * ## O que este reparo NÃO toca
 *
 *   - linhas que já têm contato — foram traduzidas com o campo presente
 *   - linhas cujo quarto segmento é o próprio número da loja — essas são
 *     saídas de verdade, e são só onze
 *   - identificadores de outro formato (a API oficial usa `wamid.…`), que não
 *     casam com `wmw.` e ficam de fora inteiros
 *
 * Contado antes de escrever: 1000 linhas do canal, 122 já certas, 11 realmente
 * da loja, 0 com id inutilizável, 867 a reparar.
 *
 * ## O QUE ESTE ARQUIVO NÃO CONSEGUIU FAZER
 *
 * `contact_address` foi reparado — 74 pessoas voltaram a aparecer no grupo de
 * revenda, 23 no outro. `direction` NÃO: o gatilho `preserve_direction` faz
 * `new.direction := old.direction` em todo update, sem condição, e a coluna
 * saiu deste comando exatamente como entrou.
 *
 * O `set direction` acima fica como está, e de propósito: apagá-lo esconderia
 * que a metade do reparo não aconteceu, e o próximo a ler isto precisa saber
 * que as 867 linhas seguem marcadas como saídas da loja.
 *
 * O gatilho está certo no que ele foi feito para impedir — um upsert de recibo
 * virando uma mensagem do avesso. Consertar essas linhas exige desligá-lo por
 * um comando, e isso é decisão de quem é dono dos dados, não minha.
 * - 2026/08/24
 */
update public.messages
set
  direction = 'incoming'::public.direction,
  contact_address = split_part(external_id, '.', 4)
where service = 'whatsapp-web'::public.service
  and direction = 'outgoing'::public.direction
  and contact_address is null
  and external_id like 'wmw.%'
  /* Cinco segmentos, exatamente — o mesmo teste que a tradução faz. */
  and array_length(string_to_array(external_id, '.'), 1) = 5
  and split_part(external_id, '.', 4) <> ''
  /* Quem falou não é a própria loja. O segundo segmento é o número da sessão,
   * então a comparação é contra o dado da linha e não contra um número
   * escrito à mão aqui — este arquivo roda uma vez, mas roda em qualquer
   * instalação. */
  and split_part(external_id, '.', 4) <> split_part(external_id, '.', 2);
