/**
 * # O funil deixa de depender de alguém lembrar de clicar
 *
 * A conversão era um botão. Evento assim subnotifica, e subnotifica justamente
 * quando a loja está corrida — que é quando ela mais vende. O número mais
 * importante do funil ficava dependendo da memória de quem atende.
 *
 * O evento certo já existia e já funcionava: `cobrancas.paga_em`. O Pix e o
 * "registrar pagamento" gravam isso hoje. Faltava a linha que liga as duas
 * coisas — e com ela a conversão se mede sozinha, COM O VALOR JUNTO.
 *
 * O botão continua, como exceção: quem vendeu por fora do sistema.
 *
 * ## E o custo, que eu tinha errado
 *
 * Eu vinha dizendo que cada teste queima um crédito do painel. Não queima:
 * medido em 2026/08/22 contra o painel do piloto, os pacotes de teste têm
 * `credits: 0` e o saldo do revendedor não se moveu depois de cinco testes.
 *
 * Quem custa crédito é o pacote PAGO — 1 no mensal, 12 no anual. Então o custo
 * que interessa medir não é o do teste: é o da VENDA. Por isso `creditos` vai
 * em `iptv_pacotes`, e o teste guarda qual plano foi vendido.
 *
 * Com receita (`cobrancas.valor`) e custo (`iptv_pacotes.creditos`) na mesma
 * linha, o painel passa a responder a única pergunta que decide se o módulo
 * continua existindo. - 2026/08/22
 */
alter table public.iptv_testes
add column if not exists cobranca_id uuid,
add column if not exists pacote_vendido_id uuid,
-- 'caro' | 'nao_funcionou' | 'sumiu' | 'outro_fornecedor'
add column if not exists motivo_perda text;

alter table public.iptv_pacotes
add column if not exists creditos integer;

comment on column public.iptv_testes.cobranca_id is
  'A cobrança que fechou este teste. Pagou ela, o teste vira convertido.';

comment on column public.iptv_testes.pacote_vendido_id is
  'Qual plano ele comprou. É por ele que se sabe quantos créditos custou.';

comment on column public.iptv_testes.motivo_perda is
  'Por que não fechou. Só se preenche depois de vencer.';

comment on column public.iptv_pacotes.creditos is
  'Quanto o painel cobra por uma venda deste plano. Teste custa 0.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'iptv_testes_cobranca_id_fkey'
  ) then
    alter table public.iptv_testes
    add constraint iptv_testes_cobranca_id_fkey
    foreign key (cobranca_id) references public.cobrancas(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'iptv_testes_pacote_vendido_id_fkey'
  ) then
    alter table public.iptv_testes
    add constraint iptv_testes_pacote_vendido_id_fkey
    foreign key (pacote_vendido_id) references public.iptv_pacotes(id)
    on delete set null;
  end if;
end $$;

/**
 * # Pagou, converteu
 *
 * Dispara quando uma cobrança passa de "não paga" para paga, e marca o teste
 * daquele telefone como convertido.
 *
 * ## Por que casa por telefone, e não por um vínculo criado antes
 *
 * Porque a cobrança quase nunca nasce do teste: quem atende gera o teste, o
 * cliente some, volta dois dias depois dizendo "quero", e aí se cria a
 * cobrança. Exigir que as duas tenham sido ligadas na criação seria exigir um
 * passo que ninguém dá — e um passo não dado é um número que não existe.
 *
 * ## A janela de trinta dias
 *
 * Sem ela, a renovação de dezembro marcaria como convertido o teste de março,
 * e a mediana de "tempo até fechar" ficaria em meses. Trinta dias é o mesmo
 * horizonte que o painel usa, e é generoso: quem some por mais de um mês e
 * volta não voltou por causa do teste.
 *
 * ## O mais recente, e só ele
 *
 * Um telefone pode ter pedido três testes. Converter os três com um pagamento
 * inflaria a conversão em três vezes. O último é o que estava valendo quando
 * ele decidiu. - 2026/08/22
 */
create or replace function public.converter_teste_ao_pagar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.paga_em is null or old.paga_em is not null then
    return new;
  end if;

  update public.iptv_testes t
  set status = 'convertido',
      convertido_em = new.paga_em,
      cobranca_id = new.id,
      updated_at = now()
  where t.id = (
    select t2.id
    from public.iptv_testes t2
    where t2.organization_id = new.organization_id
      and t2.contact_address = new.contact_address
      and t2.status <> 'convertido'
      and t2.created_at >= new.paga_em - interval '30 days'
    order by t2.created_at desc
    limit 1
  );

  return new;
end;
$$;

drop trigger if exists converter_teste_ao_pagar on public.cobrancas;

create trigger converter_teste_ao_pagar
after update on public.cobrancas
for each row
execute function public.converter_teste_ao_pagar();
