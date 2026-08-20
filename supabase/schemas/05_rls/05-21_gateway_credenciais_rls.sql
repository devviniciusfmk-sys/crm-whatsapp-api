alter table public.gateway_credenciais enable row level security;

-- ADMIN, e não membro. É a diferença desta tabela para `cobrancas`, onde quem
-- atende no balcão precisa registrar o que recebeu. Aqui não há nada de
-- operação: são as chaves que movimentam a conta bancária da loja, e quem as
-- troca é quem responde por ela.

create policy "admins manage their orgs gateway credentials"
on public.gateway_credenciais
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);

-- # O segredo é gravável e não é legível
--
-- RLS decide QUAIS LINHAS alguém alcança; não decide quais colunas. Uma política
-- que deixa o admin ler a linha deixa ele ler a chave secreta junto — e daí ela
-- sai em toda resposta de API que traga esta tabela.
--
-- Privilégio de coluna é a ferramenta certa, e é o que faz o contrato ser o
-- mesmo de uma senha: você troca, e não consulta. O admin continua enxergando
-- que existe credencial cadastrada (a linha aparece, com a chave pública), o
-- que é o bastante para a tela dizer "gateway configurado" — sem que o segredo
-- atravesse a rede uma segunda vez depois de cadastrado.
--
-- Quem lê de verdade é a função de borda, com a chave de serviço, que ignora
-- RLS e privilégio de coluna por definição. É o único lugar onde a chave
-- precisa existir em texto claro: na hora de chamar o gateway.

-- ## A ordem importa, e é contraintuitiva
--
-- Revogar SELECT de duas colunas não reduz nada enquanto existir um SELECT de
-- TABELA por cima — e o Supabase concede um por padrão a `anon` e
-- `authenticated`. O privilégio mais amplo simplesmente vence, sem erro e sem
-- aviso: o comando roda, o segredo continua legível, e quem escreveu acredita
-- que fechou.
--
-- Então tira-se o da tabela primeiro e devolve-se, coluna por coluna, só o que
-- pode sair. O que não está na lista não existe para quem consulta.

revoke select on public.gateway_credenciais from authenticated, anon;

grant select (
  organization_id, provedor, chave_publica, ativo, criado_em, atualizado_em
) on public.gateway_credenciais to authenticated, anon;

-- Escrever continua valendo nas duas colunas de segredo — é assim que a loja
-- troca uma chave vazada. Trocar exigindo apagar a linha levaria junto a chave
-- pública e o `ativo`.
grant insert, update on public.gateway_credenciais to authenticated, anon;
