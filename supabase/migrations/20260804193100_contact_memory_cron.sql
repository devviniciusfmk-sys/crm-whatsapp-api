-- Liga a memória do contato: chama `contact-memory` de vinte em vinte minutos.
--
-- Esta migração está separada da que cria a fila porque ela é a que gasta.
-- Cada rodada resume até dez contatos, e cada resumo é uma chamada de modelo
-- com o histórico recente da conversa — na ordem de mil a três mil tokens de
-- entrada e no máximo trezentos de saída. Com um modelo de US$ 0,20 por milhão
-- de tokens, uma conversa resumida custa fração de centavo; o que pode surpreender
-- é o volume, não o preço unitário.
--
-- Vinte minutos, e não a cada minuto, porque a fila só aceita conversa parada
-- há meia hora: rodar mais vezes não acharia mais ninguém, só perguntaria mais.
-- E não de hora em hora porque um cliente que volta no mesmo turno deve
-- encontrar o assistente já sabendo do que se falou de manhã.
--
-- Para desligar:  select cron.unschedule('contact-memory');
--
-- Mesmo padrão dos outros crons que chamam função de borda: `net.http_post`
-- com o `edge_functions_token`, que a função confere contra a chave de serviço.
-- - 2026/08/04
select
  cron.schedule(
    'contact-memory',
    '*/20 * * * *',
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/contact-memory',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:='{}'::jsonb,
        timeout_milliseconds:=10000
      ) as request_id
    $$
  );
