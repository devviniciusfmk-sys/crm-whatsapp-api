-- # Descadastrar o gateway
--
-- Faltava a saída. A migração anterior revogou `delete` da tabela junto com o
-- resto da escrita, e não pôs nada no lugar: uma loja que cadastrasse as
-- chaves ficava sem como tirá-las. Descobri porque a limpeza de um teste parou
-- de limpar — e parou calada, porque quem apagava não conferia o resultado.
--
-- Desligar e apagar são coisas diferentes e as duas fazem falta. `ativo = false`
-- é a loja que suspende o gateway por um mês e vai voltar; apagar é a loja que
-- trocou de provedor e não quer a chave antiga guardada em lugar nenhum.
-- - 2026/08/19

create or replace function public.remover_gateway(
  _org uuid,
  _apagar boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if _org is null or _org not in (select public.get_authorized_orgs('admin')) then
    raise exception 'sem permissão para configurar o gateway desta organização';
  end if;

  if _apagar then
    delete from public.gateway_credenciais where organization_id = _org;
  else
    update public.gateway_credenciais
       set ativo = false, atualizado_em = now()
     where organization_id = _org;
  end if;
end;
$$;

comment on function public.remover_gateway is
  'Desliga (padrão) ou apaga as credenciais do gateway. Único caminho: a tabela não concede delete.';

grant execute on function public.remover_gateway(uuid, boolean) to authenticated, anon;
