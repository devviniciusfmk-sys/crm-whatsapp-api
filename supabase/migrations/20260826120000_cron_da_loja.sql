-- O relógio da loja de números.
--
-- Escrito à mão porque `db diff` não modela `cron.schedule` — mesmo caso de
-- `20260810213000_cron_do_encaixe.sql`.
--
-- Mais simples que aquele exemplo de propósito: `expirar_reservas_loja` é SQL
-- puro, sem chamada de rede nenhuma, então o cron job chama a função direto —
-- não há `net.http_post` nem busca de URL/token no cofre para fazer, porque
-- não existe função de borda no meio do caminho.
--
-- De dez em dez minutos: a reserva expira em 30 minutos (o padrão de
-- `expirar_reservas_loja`), e uma varredura de dez em dez é granularidade de
-- sobra para isso sem gastar ciclo à toa a cada minuto.
select
  cron.schedule(
    'expirar-reservas-loja',
    '*/10 * * * *',
    $$select public.expirar_reservas_loja(30)$$
  );

-- Para desligar:  select cron.unschedule('expirar-reservas-loja');
