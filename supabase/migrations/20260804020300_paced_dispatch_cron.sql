-- Põe teto na rodada do disparo.
--
-- Até aqui o cron fazia `select net.http_post(...) from public.messages where
-- <pendente>`: uma chamada de edge function por linha elegível, sem limite. Com
-- o volume de conversa isso nunca incomodou — são poucas mensagens por minuto.
-- Deixa de servir no momento em que uma campanha materializa dezenas de milhares
-- de linhas de uma vez, porque o tick seguinte tentaria despachar todas juntas:
-- estoura o limite de mensagens por segundo da Meta, volta `130429` e derruba a
-- nota de qualidade do número.
--
-- Agora quem escolhe o lote é `public.claim_pending_messages`, que corta por
-- número, põe conversa na frente de campanha e reserva as linhas com
-- `for update skip locked`. O cron só entrega o que ela devolveu.
--
-- Escrito à mão porque `db diff` não modela `cron.schedule` — é um dos casos
-- que o CLAUDE.md lista. A função em si veio do schema declarativo
-- (`supabase/schemas/04_functions_post_tables/04-03_dispatch_queue.sql`).
--
-- Uma mudança de comportamento que vale registrar: quando a Meta devolve erro
-- transitório, o dispatcher deixa a linha sem `failed` para que ela volte à
-- fila. Antes ela voltava no minuto seguinte; agora volta quando a reserva
-- vence, cinco minutos depois. Na prática é o backoff que não havia — repetir
-- de minuto em minuto contra um `130429` é insistir exatamente no erro que pede
-- para esperar.
--
-- O orçamento de 1200 por número por rodada equivale a 20 mensagens por segundo
-- sustentadas, bem abaixo dos 80 que a Meta permite para conta comum. É
-- deliberado: encostar no teto é como se descobre que ele existe. Quando o
-- runner em lote chegar, o ritmo passa a ser controlado dentro do minuto e este
-- número vira o limite superior, não a velocidade.
select
  cron.schedule(
    'dispatch-outgoing-pending-messages',
    '* * * * *',
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/' || m.service || '-dispatcher',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:=jsonb_build_object(
          'old_record', null,
          'record', m.*,
          'type', 'INSERT',
          'table', 'messages',
          'schema', 'public'
        ),
        timeout_milliseconds:=10000
      ) as request_id
    from
      public.claim_pending_messages(1200) as m
    $$
  );
