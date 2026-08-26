/**
 * # A outra metade do reparo: a direção
 *
 * A migração anterior devolveu `contact_address` às mensagens de grupo que
 * entraram sem autoria, e não conseguiu mexer em `direction`: o gatilho
 * `preserve_direction` faz `new.direction := old.direction` em todo update,
 * sem condição. Sobraram 867 linhas de gente falando em grupo marcadas como
 * saídas da loja.
 *
 * ## Desligar uma trava é decisão de quem é dono dos dados
 *
 * A trava está certa no que ela foi feita para impedir. Um upsert de recibo
 * chega com um punhado de campos e nenhuma direção; sem ela, um webhook mal
 * comportado viraria uma conversa do avesso — e o dia em que isso acontecesse
 * ninguém saberia por quê. Ela não foi escrita pensando em reparo, e não é
 * defeito dela.
 *
 * Este comando a desliga por uma instrução e a religa em seguida. Foi pedido
 * explicitamente pelo dono dos dados em 2026/08/24, depois de eu mostrar o
 * número: 867 de 877 mensagens de um grupo com 75 pessoas.
 *
 * ## Por que é seguro mudar a direção destas linhas
 *
 * Mudar para `incoming` acorda `handle_mark_as_read_to_dispatcher`. Ele não
 * dispara aqui, por dois motivos independentes: o `when` exige que
 * `status->>'read'` ou `'typing'` tenham MUDADO, e este comando não toca em
 * `status`; e exige `status->>'pending'` não nulo, que linha de histórico não
 * tem. `z_notify_webhook_messages` dispara, e não há webhook cadastrado.
 *
 * ## O recorte
 *
 * Só o que a migração anterior já reparou, e nada além: linhas cujo
 * `contact_address` é EXATAMENTE o quarto segmento do `external_id`. Ou seja,
 * este comando só toca no que ele mesmo pode explicar. Uma linha que alguém
 * tenha corrigido à mão desde então não casa, e fica quieta.
 *
 * `enable trigger` na mesma transação: se o update falhar, a trava volta com
 * ele. Não existe um estado em que este arquivo deixe a tabela desprotegida.
 * - 2026/08/24
 */
alter table public.messages disable trigger preserve_direction;

update public.messages
set direction = 'incoming'::public.direction
where service = 'whatsapp-web'::public.service
  and direction = 'outgoing'::public.direction
  and contact_address is not null
  and external_id like 'wmw.%'
  and array_length(string_to_array(external_id, '.'), 1) = 5
  /* O contato veio do id, e é isso que amarra este comando ao anterior. */
  and contact_address = split_part(external_id, '.', 4)
  /* E quem falou não é a própria loja — essas onze estão certas como estão. */
  and split_part(external_id, '.', 4) <> split_part(external_id, '.', 2);

alter table public.messages enable trigger preserve_direction;
