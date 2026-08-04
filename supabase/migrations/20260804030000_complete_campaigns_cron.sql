-- Chama `complete_finished_campaigns` de cinco em cinco minutos.
--
-- Escrito à mão porque `db diff` não modela `cron.schedule` — é um dos casos
-- que o CLAUDE.md lista. A função em si veio do schema declarativo
-- (`supabase/schemas/04_functions_post_tables/04-04_campaigns.sql`).
--
-- Cinco minutos, e não a cada minuto, porque nada depende de a campanha fechar
-- depressa: é estado de tela, não de entrega. E não de hora em hora porque
-- alguém que acabou de disparar para trezentas pessoas volta na tela em poucos
-- minutos para ver como foi, e encontrar "correndo" quando já acabou é a mesma
-- confusão que a de nunca fechar.
--
-- A consulta é barata: o índice parcial `campaigns_running_idx` já restringe o
-- lado de fora, e o `not exists` usa `messages_campaign_id_idx`, também parcial.
-- Sem campanha em andamento, não lê nada.
select
  cron.schedule(
    'complete-finished-campaigns',
    '*/5 * * * *',
    $$
    select public.complete_finished_campaigns()
    $$
  );
