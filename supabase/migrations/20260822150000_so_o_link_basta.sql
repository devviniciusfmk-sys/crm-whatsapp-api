-- O endereço do servidor deixa de ser obrigatório.
--
-- O robô que gera o teste é um link inteiro — e ele é o único campo que a loja
-- realmente precisa colar. Exigir também a raiz do servidor era pedir duas
-- vezes a mesma informação: a raiz está dentro do link.
--
-- Medido contra um servidor real em 2026/08/22: uma chamada ao link, sem
-- credencial nenhuma, devolveu usuário, senha, DNS, prazo e a mensagem inteira
-- já formatada. Tudo o mais é afinação.
alter table public.iptv_servidores
alter column base_url drop not null;

comment on column public.iptv_servidores.base_url is
  'A raiz do servidor. Opcional: sem ela, a origem sai do link do pacote.';
