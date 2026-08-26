-- O estoque da PRÓPRIA plataforma: números de WhatsApp já registrados na
-- Meta, com nome verificado e um token de usuário do sistema permanente
-- pronto, vendidos a lojas por um preço fixo (ou quase — ver `preco`).
--
-- Não confundir com `organizations_addresses`, que é o número JÁ conectado a
-- uma organização. Este aqui é o inventário anterior a isso: um número pode
-- passar meses aqui sem dono nenhum, esperando alguém comprar.
--
-- ## O ciclo de vida
--
-- `disponivel` -> `reservado` -> `vendido` -> `conectado`.
--
-- `disponivel` é o normal: no catálogo, à venda. `reservado` é o instante
-- entre alguém clicar em "comprar" e o pagamento cair — existe para que dois
-- compradores não fechem o mesmo número ao mesmo tempo; ver o guard de
-- corrida em `reservar_numero_loja`. `vendido` é pago e já com dono, mas
-- ainda esperando um admin da plataforma conectar de fato — a etapa manual
-- de configurar o número do lado da Meta. `conectado` é o fim da linha: existe
-- uma linha em `organizations_addresses` para ele, e a organização já está
-- mandando mensagem por ali.
--
-- `desativado` é diferente dos outros quatro: não é uma etapa da venda, é a
-- saída dela. Um número que a plataforma decide tirar de circulação — porque
-- a Meta baniu, porque o custo da linha mudou, porque não vale mais a pena —
-- vai para cá e não volta a aparecer no catálogo.
--
-- ## Por que não há RLS de organização aqui
--
-- Toda outra tabela deste arquivo que carrega `organization_id` tem uma
-- política que checa `get_authorized_orgs`. Esta não tem — ver
-- `05-31_loja_rls.sql`, que não define nenhuma política para esta tabela —
-- porque `organization_id` fica nulo enquanto o número não é vendido: não
-- existe organização "dona" de uma linha `disponivel` para autorizar. E depois
-- de vendido, o catálogo que o comprador vê já não é este número específico
-- de qualquer forma — é composto campo a campo por uma função de borda com a
-- chave de serviço, que decide o que mostrar sem expor a tabela inteira.
create table public.loja_numeros (
  id uuid primary key default gen_random_uuid(),
  phone_number_id text not null unique,
  waba_id text not null,
  business_id text,
  phone_number text,
  verified_name text,
  preco numeric not null default 49.90,
  status text not null default 'disponivel'
    check (status in ('disponivel','reservado','vendido','conectado','desativado')),
  organization_id uuid references public.organizations(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create trigger set_updated_at before update on public.loja_numeros
  for each row execute function public.moddatetime('atualizado_em');
