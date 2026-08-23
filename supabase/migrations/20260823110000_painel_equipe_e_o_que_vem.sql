/**
 * # Quem está atendendo, e o que vem
 *
 * Duas perguntas que o painel não respondia, e que quem tem equipe faz todo
 * dia. Entram na mesma função porque é a mesma tela e a mesma chamada — quatro
 * idas ao banco para desenhar um painel é o painel demorando a abrir.
 *
 * ## "Quem está atendendo" é ATIVIDADE, e não presença
 *
 * Não há presença neste sistema: nenhuma coluna de `last_seen`, nenhuma tabela
 * de sessão. Construir bolinha verde de verdade exigiria conexão viva por
 * pessoa, e ela mente do jeito mais comum que existe — a aba aberta no almoço
 * continua "online".
 *
 * Então esta função responde o que o registro sabe: quantas conversas cada um
 * tem na mão, e quando foi a última vez que ele respondeu alguém. É menos do
 * que "online" e é mais honesto — e, na prática, é o que a pergunta quer saber.
 *
 * ## E o robô não entra
 *
 * `agents` guarda gente e assistente na mesma tabela, separados por `ai`. Sem
 * o filtro, o robô apareceria como o atendente mais produtivo da loja toda
 * manhã, e o número de todo mundo pareceria pequeno ao lado.
 *
 * ## "O que vem" é contagem, e não lista
 *
 * Três números com um caminho cada: compromissos de hoje, mensagens marcadas
 * para sair hoje, e renovações vencendo na semana. O detalhe continua morando
 * na Agenda e em Vencimentos — trazer a lista para cá seria a terceira cópia
 * da mesma tela. - 2026/08/23
 */
create or replace function public.painel_da_equipe(p_org uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  _fuso text;
  _hoje_inicio timestamptz;
  _hoje_fim timestamptz;
begin
  select coalesce(o.extra->>'timezone', 'America/Sao_Paulo')
  into _fuso
  from public.organizations o
  where o.id = p_org;

  /* "Hoje" no fuso da loja, e não em UTC: às 21h de Brasília o UTC já virou
   * amanhã, e a agenda do dia apareceria vazia justamente no fim do
   * expediente. */
  _hoje_inicio := date_trunc('day', now() at time zone _fuso) at time zone _fuso;
  _hoje_fim := _hoje_inicio + interval '1 day';

  return jsonb_build_object(
    'atendendo', coalesce((
      select jsonb_agg(linha order by linha->>'ultima_resposta' desc nulls last)
      from (
        select jsonb_build_object(
          'agente', a.id,
          'nome', a.name,
          /* Quantas conversas ele é dono. Ver `extra.dono` — quem responde
           * primeiro fica com ela. */
          'conversas', (
            select count(*)
            from public.conversations c
            where c.organization_id = p_org
              and c.status <> 'archived'
              and c.extra->'dono'->>'agente' = a.id::text
          ),
          'ultima_resposta', (
            select max(m.timestamp)
            from public.messages m
            where m.organization_id = p_org
              and m.agent_id = a.id
              and m.direction = 'outgoing'
          )
        ) as linha
        from public.agents a
        where a.organization_id = p_org
          /* O assistente fora: ele responderia mais que todo mundo junto, e o
           * quadro deixaria de ser sobre a equipe. */
          and coalesce(a.ai, false) = false
      ) as linhas
    ), '[]'::jsonb),

    'vem', jsonb_build_object(
      'compromissos_hoje', (
        select count(*)
        from public.appointments ap
        where ap.organization_id = p_org
          and ap.starts_at >= _hoje_inicio
          and ap.starts_at < _hoje_fim
          and ap.status <> 'cancelled'
      ),
      /**
       * Mensagem marcada é a que ainda VAI sair: saída, com hora no futuro e
       * fora de campanha.
       *
       * Sem o corte de campanha, um disparo de trezentos contatos apareceria
       * como trezentas mensagens marcadas para hoje — e o número que existe
       * para dizer "olha o que vai sair" viraria ruído todo dia de campanha.
       */
      'mensagens_hoje', (
        select count(*)
        from public.messages m
        where m.organization_id = p_org
          and m.direction = 'outgoing'
          and m.campaign_id is null
          and m.timestamp > now()
          and m.timestamp < _hoje_fim
      ),
      'renovacoes_semana', (
        select count(*)
        from public.cobrancas c
        where c.organization_id = p_org
          and c.status in ('aberta', 'parcial')
          and c.vence_em is not null
          and c.vence_em >= now()
          and c.vence_em < now() + interval '7 days'
      )
    )
  );
end;
$$;

revoke execute on function public.painel_da_equipe(uuid) from public, anon;
grant execute on function public.painel_da_equipe(uuid) to authenticated;
