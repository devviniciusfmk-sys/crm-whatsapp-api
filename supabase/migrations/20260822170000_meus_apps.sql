-- Os apps que ESTA loja usa de verdade.
--
-- O catálogo se semeia sozinho com tudo que o painel oferece — nove, quinze,
-- às vezes mais. Quem atende vende dois ou três. O menu de escolher app virava
-- uma lista de nomes onde os que importam estavam no meio dos que não.
--
-- Uma estrela resolve as duas reclamações de uma vez: o que é favorito sobe, e
-- o que não é sai da frente. Sem estrela nenhuma, a lista continua inteira —
-- que é como ela nasce, e o único estado em que esconder algo seria esconder
-- tudo. - 2026/08/22
alter table public.iptv_apps
add column if not exists favorito boolean not null default false;

comment on column public.iptv_apps.favorito is
  'Sobe no menu de escolher app; havendo favoritos, só eles aparecem de cara.';
