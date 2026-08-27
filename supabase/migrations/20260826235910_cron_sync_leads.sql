-- Sincroniza o funil de vendas com a base externa de leads a cada 30
-- minutos. Mesmo padrão de `cron_do_encaixe.sql`: cron.schedule não é
-- modelado pelo `db diff`, por isso este arquivo é escrito à mão.
select cron.schedule('sync-leads-externos', '*/30 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/leads-sync',
    headers := jsonb_build_object('content-type','application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')),
    body := '{}'::jsonb, timeout_milliseconds := 60000
  ) as request_id
$$);
