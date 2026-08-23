/**
 * # A chave estrangeira que faltava em `contact_id`
 *
 * A coluna existia e guardava o id da ficha, mas sem vínculo declarado. Duas
 * consequências, e a segunda foi a que apareceu na tela:
 *
 *   Nada garantia que o id existisse. Apagar um contato deixava o teste
 *   apontando para o nada, e ninguém ficava sabendo.
 *
 *   O PostgREST não sabia juntar as duas tabelas. Pedir o nome do cliente
 *   junto com o teste devolvia `PGRST200` — "no matches were found" —, e a
 *   tela, que lia `data ?? []`, mostrava lista VAZIA sem erro nenhum. Um
 *   painel que diz "nenhum teste para vencer" tendo dois é pior que um painel
 *   quebrado, porque ninguém vai procurar o defeito.
 *
 * `on delete set null` e não `cascade`: apagar a ficha de um cliente não pode
 * levar embora o histórico de que ele testou. É esse histórico que responde
 * "de onde veio este cliente" seis meses depois — a mesma razão pela qual o
 * telefone fica repetido na linha. - 2026/08/22
 */
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'iptv_testes_contact_id_fkey'
  ) then
    alter table public.iptv_testes
    add constraint iptv_testes_contact_id_fkey
    foreign key (contact_id) references public.contacts(id) on delete set null;
  end if;
end $$;
