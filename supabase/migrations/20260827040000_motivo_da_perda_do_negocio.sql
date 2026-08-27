-- Escrita à mão, mesmo motivo das anteriores: drift no `supabase db diff`
-- entre schemas e histórico já aplicado.

alter table "public"."negocios" add column "motivo_perda" text;

alter table "public"."negocios"
  add constraint "negocios_motivo_perda_check"
  check (motivo_perda in ('preco','sem_interesse','concorrente','sumiu'));

alter table "public"."negocios"
  add constraint "negocios_motivo_perda_so_quando_perdido_check"
  check (motivo_perda is null or estagio = 'perdido');
