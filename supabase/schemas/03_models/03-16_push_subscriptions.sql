-- Onde avisar quem cuida da loja, quando ele não está olhando a tela.
--
-- A reclamação já chega vermelha na lista desde 2026/08/09 — e vermelho só
-- serve para quem está olhando. Numa barbearia ninguém está: o dono está de
-- tesoura na mão, e a tela fica no fundo da loja, apagada. Medido em
-- 2026/08/10: 6 de 30 conversas de um dia de movimento eram reclamações, todas
-- corretamente marcadas, e nenhuma teria puxado ninguém.
--
-- Uma inscrição é um NAVEGADOR, não uma pessoa: o mesmo dono no celular e no
-- balcão são duas linhas, e ele quer o aviso nos dois. Por isso a chave é o
-- `endpoint`, que é o que o navegador dá e o que o serviço de push reconhece.
--
-- Some junto com o usuário e junto com a organização: um aviso sobre uma loja
-- que não existe mais não tem para onde ir. - 2026/08/10
create table public.push_subscriptions (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  user_id uuid not null,
  -- A URL que o serviço de push do navegador deu. É ela que identifica o
  -- aparelho, e é ela que expira quando a pessoa limpa os dados do navegador.
  endpoint text not null,
  -- As duas chaves da criptografia ponta a ponta do Web Push. Sem elas a
  -- mensagem não pode ser cifrada, e o serviço de push recusa.
  p256dh text not null,
  auth text not null,
  -- Para dizer "este é o seu celular" numa lista de três aparelhos, e para
  -- desligar o que a pessoa não reconhece.
  user_agent text,
  extra jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.push_subscriptions
add constraint push_subscriptions_pkey
primary key (id);

alter table only public.push_subscriptions
add constraint push_subscriptions_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.push_subscriptions
add constraint push_subscriptions_user_id_fkey
foreign key (user_id)
references auth.users(id)
on delete cascade;

-- O mesmo navegador reinscrevendo é uma ATUALIZAÇÃO, não uma linha nova.
--
-- O navegador troca as chaves sozinho de tempos em tempos, e sem esta restrição
-- cada troca deixaria para trás uma inscrição morta que continua recebendo
-- envio — e cada envio a um endpoint morto é uma resposta 410 que ninguém lê.
alter table only public.push_subscriptions
add constraint push_subscriptions_endpoint_key
unique (endpoint);

-- A pergunta do envio é sempre "quem avisar nesta loja".
create index push_subscriptions_organization_idx
on public.push_subscriptions
using btree (organization_id);

create trigger set_updated_at
before update
on public.push_subscriptions
for each row
execute function public.moddatetime('updated_at');

create trigger set_extra
before update
on public.push_subscriptions
for each row
execute function public.merge_update('extra');
