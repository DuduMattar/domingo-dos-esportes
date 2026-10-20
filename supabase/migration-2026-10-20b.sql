-- =====================================================================
-- Migração 20/10/2026 (b) — palpites em todos os eventos + apuração
-- Rode no SQL Editor depois de migration-2026-10-20.sql. Pode rodar mais de uma vez.
-- =====================================================================

-- Novo esporte "eleicao" e eventos só de palpite (fora da agenda)
alter table public.events drop constraint if exists events_sport_check;
alter table public.events add constraint events_sport_check
  check (sport in ('f1','futebol','tenis','nfl','turma','eleicao'));
alter table public.events add column if not exists in_agenda boolean not null default true;

-- admin_upsert_event passa a gravar in_agenda
create or replace function public.admin_upsert_event(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  insert into public.events as e (id, sport, title, subtitle, starts_at, ends_at, time_kind,
    watch_label, watch_url, source_label, source_url, checked_at, note,
    pick_enabled, pick_question, options, sort, in_agenda)
  values (
    p->>'id', p->>'sport', p->>'title', nullif(p->>'subtitle',''),
    nullif(p->>'starts_at','')::timestamptz, nullif(p->>'ends_at','')::timestamptz,
    coalesce(nullif(p->>'time_kind',''),'confirmado'),
    nullif(p->>'watch_label',''), nullif(p->>'watch_url',''),
    nullif(p->>'source_label',''), nullif(p->>'source_url',''),
    nullif(p->>'checked_at','')::date, nullif(p->>'note',''),
    coalesce((p->>'pick_enabled')::boolean, false), nullif(p->>'pick_question',''),
    coalesce(p->'options','[]'::jsonb), coalesce((p->>'sort')::int, 0),
    coalesce((p->>'in_agenda')::boolean, true))
  on conflict (id) do update set
    sport = excluded.sport, title = excluded.title, subtitle = excluded.subtitle,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, time_kind = excluded.time_kind,
    watch_label = excluded.watch_label, watch_url = excluded.watch_url,
    source_label = excluded.source_label, source_url = excluded.source_url,
    checked_at = excluded.checked_at, note = excluded.note,
    pick_enabled = excluded.pick_enabled, pick_question = excluded.pick_question,
    options = excluded.options, sort = excluded.sort, in_agenda = excluded.in_agenda;
end $$;
revoke execute on function public.admin_upsert_event(jsonb) from public, anon;
grant execute on function public.admin_upsert_event(jsonb) to authenticated;

-- Votação vira "eleicao"; apuração entra na agenda às 17h com palpite
update public.events set sport = 'eleicao' where id = 'eleicao';

insert into public.events (id, sport, title, subtitle, starts_at, ends_at, time_kind,
  watch_label, watch_url, source_label, source_url, checked_at, note,
  pick_enabled, pick_question, options, sort, in_agenda) values
('apuracao', 'eleicao', 'Apuração do 2º turno', 'Presidente · Flávio Bolsonaro (PL) x Lula (PT)',
  '2026-10-25 17:00-03', null, 'confirmado',
  'Resultados TSE (grátis)', 'https://resultados.tse.jus.br', 'TSE (horários) · imprensa (candidatos)',
  'https://www.tse.jus.br/eleicoes/calendario-eleitoral', '2026-10-20',
  'Divulgação começa às 17h, quando as seções fecham. Não há hora marcada para o resultado final: depende do ritmo da apuração. Palpite fecha às 17h, antes da primeira parcial.',
  true, 'Quem vence o 2º turno?', '["Flávio Bolsonaro","Lula"]', 6, true)
on conflict (id) do nothing;

-- Palpites nos eventos que já existem
update public.events set pick_enabled = true where id in ('almaty','nfl-paris','beach');
update public.events set pick_question = 'Quem vence?', options = '["Steelers","Saints"]'
 where id = 'nfl-paris' and options = '[]'::jsonb;
update public.events set pick_question = 'Quem vence a final?' where id = 'almaty' and pick_question is null;
update public.events set pick_question = 'Qual dupla vence?' where id = 'beach' and pick_question is null;

-- Um palpite por jogo da NFL (ficam só na aba Palpites; a agenda mantém os cards agrupados)
insert into public.events (id, sport, title, subtitle, starts_at, time_kind,
  watch_label, watch_url, source_label, source_url, checked_at,
  pick_enabled, pick_question, options, sort, in_agenda) values
('nfl-sf-atl',  'nfl', '49ers x Falcons',     'NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["49ers","Falcons"]',     41, false),
('nfl-cin-bal', 'nfl', 'Bengals x Ravens',    'NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Bengals","Ravens"]',    42, false),
('nfl-tb-car',  'nfl', 'Buccaneers x Panthers','NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Buccaneers","Panthers"]',43, false),
('nfl-nyg-hou', 'nfl', 'Giants x Texans',     'NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Giants","Texans"]',     44, false),
('nfl-ind-min', 'nfl', 'Colts x Vikings',     'NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Colts","Vikings"]',     45, false),
('nfl-mia-nyj', 'nfl', 'Dolphins x Jets',     'NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Dolphins","Jets"]',     46, false),
('nfl-cle-ten', 'nfl', 'Browns x Titans',     'NFL · Semana 7', '2026-10-25 14:00-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Browns","Titans"]',     47, false),
('nfl-den-ari', 'nfl', 'Broncos x Cardinals', 'NFL · Semana 7', '2026-10-25 17:05-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Broncos","Cardinals"]', 81, false),
('nfl-gb-det',  'nfl', 'Packers x Lions',     'NFL · Semana 7', '2026-10-25 17:25-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Packers","Lions"]',     82, false),
('nfl-lar-lv',  'nfl', 'Rams x Raiders',      'NFL · Semana 7', '2026-10-25 17:25-03', 'confirmado', 'NFL Game Pass (pago)', 'https://www.dazn.com', 'NFL.com', 'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20', true, 'Quem vence?', '["Rams","Raiders"]',      83, false)
on conflict (id) do nothing;

-- Apuração entra na disputa da TV das 17h
update public.tv_polls set event_ids = array_append(event_ids, 'apuracao')
 where id = 'tv-17h' and not ('apuracao' = any(event_ids));
