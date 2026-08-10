-- O relógio do convite de encaixe.
--
-- Escrito à mão porque `db diff` não modela `cron.schedule` — é o mesmo caso do
-- despacho ritmado e da escalada de transferência.
--
-- De cinco em cinco minutos, e não de minuto em minuto: o prazo do convite é de
-- meia hora, e uma varredura por minuto seria trinta consultas para descobrir
-- trinta vezes que ainda não deu a hora. Cinco minutos é a granularidade que o
-- prazo realmente tem.
select
  cron.schedule(
    'expire-waitlist-offers',
    '*/5 * * * *',
    $$
    select
      net.http_post(
        url := (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'edge_functions_url'
        ) || '/encaixe',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'edge_functions_token'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
      ) as request_id
    $$
  );

-- Para desligar:  select cron.unschedule('expire-waitlist-offers');
