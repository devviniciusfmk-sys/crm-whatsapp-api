-- Escrita à mão, mesmo motivo das anteriores: drift no `supabase db diff`
-- entre schemas e histórico já aplicado.
--
-- Corrige o grant de 20260827050000: quem chama só com api-key (sem JWT
-- de usuário) autentica como `anon` pro PostgREST, não `authenticated` —
-- confirmado testando de verdade (a primeira versão devolvia 42501
-- "permission denied"). Mesmo par de papéis que a policy de `negocios`
-- já usa.

grant execute on function public.importar_negocios_do_cliente(jsonb)
to anon;
