/**
 * Marca reunião com o negócio: preenche `reuniao_em`, atribui
 * `responsavel_id` a quem chamou (só se ainda não tiver dono — quem chega
 * primeiro fica com a comissão), e credita a comissão de
 * `reuniao_marcada` em `comissoes`.
 *
 * Reagendar (chamar de novo num negócio que já tem reunião ativa) só
 * atualiza `reuniao_em` — não credita uma segunda vez. A trava é o índice
 * único parcial em `comissoes` (`comissoes_negocio_tipo_ativa_idx`): só
 * existe comissão nova quando não há nenhuma ativa daquele tipo ainda.
 */
create or replace function public.marcar_reuniao_negocio(
  _negocio uuid,
  _quando timestamptz
) returns public.negocios
language plpgsql
security definer
set search_path = ''
as $$
declare
  _negocio_row public.negocios%rowtype;
  _valor numeric;
begin
  update public.negocios
  set reuniao_em = _quando,
      responsavel_id = coalesce(responsavel_id, auth.uid())
  where id = _negocio
    and organization_id in (select public.get_authorized_orgs('member'))
  returning * into _negocio_row;

  if not found then
    raise exception 'negócio não encontrado ou sem permissão';
  end if;

  if exists (
    select 1 from public.comissoes
    where negocio_id = _negocio and tipo = 'reuniao_marcada' and status = 'ativa'
  ) then
    return _negocio_row;
  end if;

  select coalesce((o.extra->>'sdr_comissao_por_reuniao')::numeric, 30)
  into _valor
  from public.organizations o
  where o.id = _negocio_row.organization_id;

  insert into public.comissoes (organization_id, negocio_id, agent_id, tipo, valor)
  values (_negocio_row.organization_id, _negocio, _negocio_row.responsavel_id, 'reuniao_marcada', _valor);

  return _negocio_row;
end;
$$;

revoke execute on function public.marcar_reuniao_negocio(uuid, timestamptz)
from public, anon;

grant execute on function public.marcar_reuniao_negocio(uuid, timestamptz)
to authenticated;

/**
 * Desmarca a reunião e estorna a comissão ativa de `reuniao_marcada`
 * daquele negócio, se houver. Marcar de novo depois disso credita uma
 * linha NOVA — a antiga fica estornada para sempre, como registro.
 */
create or replace function public.desmarcar_reuniao_negocio(_negocio uuid)
returns public.negocios
language plpgsql
security definer
set search_path = ''
as $$
declare
  _negocio_row public.negocios%rowtype;
begin
  update public.negocios
  set reuniao_em = null
  where id = _negocio
    and organization_id in (select public.get_authorized_orgs('member'))
  returning * into _negocio_row;

  if not found then
    raise exception 'negócio não encontrado ou sem permissão';
  end if;

  update public.comissoes
  set status = 'estornada', estornado_em = now()
  where negocio_id = _negocio and tipo = 'reuniao_marcada' and status = 'ativa';

  return _negocio_row;
end;
$$;

revoke execute on function public.desmarcar_reuniao_negocio(uuid)
from public, anon;

grant execute on function public.desmarcar_reuniao_negocio(uuid)
to authenticated;
