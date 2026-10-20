-- =====================================================================
-- Domingo dos Esportes — schema Supabase (Postgres)
-- Rode este arquivo inteiro no SQL Editor do Supabase (uma vez).
-- Regra de ouro: o navegador (chave anon/publishable) só LÊ tabelas.
-- Toda escrita passa pelas funções abaixo, que validam as regras.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  place       text not null default 'A definir',
  place_url   text,
  meet_time   text not null default 'A definir',
  notes       text,
  beach_pairs text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.participants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 40),
  name_norm   text not null unique,
  rsvp        text not null default 'sim' check (rsvp in ('sim','talvez','nao')),
  plays_beach boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Vínculo aparelho -> participante. Guarda só o hash do token. Sem leitura pública.
create table if not exists public.devices (
  device_hash    text primary key,
  participant_id uuid not null references public.participants(id) on delete cascade,
  created_at     timestamptz not null default now()
);

create table if not exists public.events (
  id            text primary key,
  sport         text not null check (sport in ('f1','futebol','tenis','nfl','turma')),
  title         text not null,
  subtitle      text,
  starts_at     timestamptz,           -- null = "A confirmar"
  ends_at       timestamptz,
  time_kind     text not null default 'confirmado'
                check (time_kind in ('confirmado','nao_antes_de','a_confirmar')),
  watch_label   text,                  -- null = "A confirmar"
  watch_url     text,
  source_label  text,
  source_url    text,
  checked_at    date,
  note          text,
  pick_enabled  boolean not null default false,
  pick_question text,
  options       jsonb not null default '[]'::jsonb,
  result        text,
  picks_locked  boolean not null default false,
  sort          int not null default 0
);

create table if not exists public.items (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 60),
  category       text not null check (category in ('comida','bebida','gelo','outros')),
  qty            text check (char_length(qty) <= 20),
  created_at     timestamptz not null default now()
);

create table if not exists public.picks (
  participant_id uuid not null references public.participants(id) on delete cascade,
  event_id       text not null references public.events(id) on delete cascade,
  choice         text not null,
  updated_at     timestamptz not null default now(),
  primary key (participant_id, event_id)
);

create table if not exists public.tv_polls (
  id        text primary key,
  title     text not null,
  event_ids text[] not null,
  closes_at timestamptz,
  locked    boolean not null default false
);

create table if not exists public.tv_votes (
  poll_id        text not null references public.tv_polls(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  event_id       text not null,
  updated_at     timestamptz not null default now(),
  primary key (poll_id, participant_id)
);

create table if not exists public.admins (
  user_id uuid primary key
);

-- ---------------------------------------------------------------------
-- Permissões: leitura pública, escrita só via funções
-- ---------------------------------------------------------------------
alter table public.settings     enable row level security;
alter table public.participants enable row level security;
alter table public.devices      enable row level security;
alter table public.events       enable row level security;
alter table public.items        enable row level security;
alter table public.picks        enable row level security;
alter table public.tv_polls     enable row level security;
alter table public.tv_votes     enable row level security;
alter table public.admins       enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['settings','participants','events','items','picks','tv_polls','tv_votes'] loop
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('drop policy if exists leitura_publica on public.%I', t);
    execute format('create policy leitura_publica on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;
-- devices e admins: nenhuma policy => ninguém lê pelo navegador.

-- ---------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------
create or replace function public._norm(t text) returns text
language sql stable set search_path = public, extensions as $$
  select lower(regexp_replace(trim(extensions.unaccent(coalesce(t,''))), '\s+', ' ', 'g'))
$$;

create or replace function public._hash(p_token text) returns text
language plpgsql stable set search_path = public, extensions as $$
begin
  if p_token is null or char_length(p_token) < 20 then
    raise exception 'TOKEN_INVALIDO';
  end if;
  return encode(extensions.digest(p_token, 'sha256'), 'hex');
end $$;

create or replace function public._me(p_token text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select participant_id from public.devices where device_hash = public._hash(p_token)
$$;

create or replace function public._me_required(p_token text) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid;
begin
  v := public._me(p_token);
  if v is null then raise exception 'ENTRE_PRIMEIRO'; end if;
  return v;
end $$;

create or replace function public._is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._is_admin() then raise exception 'SOMENTE_ORGANIZADOR'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Funções dos convidados (recebem o token do aparelho)
-- ---------------------------------------------------------------------
create or replace function public.whoami(p_token text) returns uuid
language sql stable security definer set search_path = public as $$
  select public._me(p_token)
$$;

create or replace function public.join_or_update(p_token text, p_name text, p_rsvp text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_me    uuid := public._me(p_token);
  v_name  text := regexp_replace(trim(coalesce(p_name,'')), '\s+', ' ', 'g');
  v_norm  text := public._norm(p_name);
  v_other uuid;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'NOME_INVALIDO';
  end if;
  if p_rsvp not in ('sim','talvez','nao') then raise exception 'RSVP_INVALIDO'; end if;

  select id into v_other from public.participants where name_norm = v_norm;

  if v_me is null then
    if v_other is not null then
      -- Nome existe. Só pode "assumir" se o organizador liberou (sem aparelho vinculado).
      if exists (select 1 from public.devices where participant_id = v_other) then
        raise exception 'NOME_EM_USO';
      end if;
      insert into public.devices(device_hash, participant_id) values (public._hash(p_token), v_other);
      update public.participants set rsvp = p_rsvp, name = v_name, updated_at = now() where id = v_other;
      return v_other;
    end if;
    if (select count(*) from public.participants) >= 150 then raise exception 'LISTA_CHEIA'; end if;
    insert into public.participants(name, name_norm, rsvp) values (v_name, v_norm, p_rsvp)
      returning id into v_me;
    insert into public.devices(device_hash, participant_id) values (public._hash(p_token), v_me);
    return v_me;
  end if;

  if v_other is not null and v_other <> v_me then raise exception 'NOME_EM_USO'; end if;
  update public.participants
     set name = v_name, name_norm = v_norm, rsvp = p_rsvp, updated_at = now()
   where id = v_me;
  return v_me;
end $$;

create or replace function public.set_beach(p_token text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.participants set plays_beach = coalesce(p_on,false), updated_at = now()
   where id = public._me_required(p_token);
end $$;

create or replace function public.add_item(p_token text, p_name text, p_category text, p_qty text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public._me_required(p_token); v_id uuid;
begin
  if (select count(*) from public.items where participant_id = v_me) >= 20 then
    raise exception 'ITENS_DEMAIS';
  end if;
  insert into public.items(participant_id, name, category, qty)
  values (v_me, trim(p_name), p_category, nullif(trim(coalesce(p_qty,'')),''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_item(p_token text, p_id uuid, p_name text, p_category text, p_qty text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.items
     set name = trim(p_name), category = p_category, qty = nullif(trim(coalesce(p_qty,'')),'')
   where id = p_id and participant_id = public._me_required(p_token);
  if not found then raise exception 'ITEM_NAO_E_SEU'; end if;
end $$;

create or replace function public.remove_item(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.items where id = p_id and participant_id = public._me_required(p_token);
  if not found then raise exception 'ITEM_NAO_E_SEU'; end if;
end $$;

create or replace function public.set_pick(p_token text, p_event text, p_choice text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public._me_required(p_token); e public.events;
begin
  select * into e from public.events where id = p_event;
  if not found or not e.pick_enabled then raise exception 'SEM_PALPITE'; end if;
  if e.picks_locked or e.result is not null or (e.starts_at is not null and now() >= e.starts_at) then
    raise exception 'PALPITES_ENCERRADOS';
  end if;
  if not (e.options ? p_choice) then raise exception 'OPCAO_INVALIDA'; end if;
  insert into public.picks(participant_id, event_id, choice) values (v_me, p_event, p_choice)
  on conflict (participant_id, event_id) do update set choice = excluded.choice, updated_at = now();
end $$;

create or replace function public.cast_tv_vote(p_token text, p_poll text, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public._me_required(p_token); p public.tv_polls;
begin
  select * into p from public.tv_polls where id = p_poll;
  if not found then raise exception 'VOTACAO_INEXISTENTE'; end if;
  if p.locked or (p.closes_at is not null and now() >= p.closes_at) then
    raise exception 'VOTACAO_ENCERRADA';
  end if;
  if not (p_event = any(p.event_ids)) then raise exception 'OPCAO_INVALIDA'; end if;
  insert into public.tv_votes(poll_id, participant_id, event_id) values (p_poll, v_me, p_event)
  on conflict (poll_id, participant_id) do update set event_id = excluded.event_id, updated_at = now();
end $$;

-- ---------------------------------------------------------------------
-- Funções do organizador (exigem login no Supabase Auth + estar em admins)
-- ---------------------------------------------------------------------
create or replace function public.am_i_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public._is_admin()
$$;

create or replace function public.admin_update_settings(
  p_place text, p_place_url text, p_meet_time text, p_notes text, p_beach_pairs text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  insert into public.settings(id) values (1) on conflict do nothing;
  update public.settings set
    place = coalesce(nullif(trim(p_place),''), 'A definir'),
    place_url = nullif(trim(p_place_url),''),
    meet_time = coalesce(nullif(trim(p_meet_time),''), 'A definir'),
    notes = nullif(trim(p_notes),''),
    beach_pairs = nullif(trim(p_beach_pairs),''),
    updated_at = now()
  where id = 1;
end $$;

create or replace function public.admin_upsert_event(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  insert into public.events as e (id, sport, title, subtitle, starts_at, ends_at, time_kind,
    watch_label, watch_url, source_label, source_url, checked_at, note,
    pick_enabled, pick_question, options, sort)
  values (
    p->>'id', p->>'sport', p->>'title', nullif(p->>'subtitle',''),
    nullif(p->>'starts_at','')::timestamptz, nullif(p->>'ends_at','')::timestamptz,
    coalesce(nullif(p->>'time_kind',''),'confirmado'),
    nullif(p->>'watch_label',''), nullif(p->>'watch_url',''),
    nullif(p->>'source_label',''), nullif(p->>'source_url',''),
    nullif(p->>'checked_at','')::date, nullif(p->>'note',''),
    coalesce((p->>'pick_enabled')::boolean, false), nullif(p->>'pick_question',''),
    coalesce(p->'options','[]'::jsonb), coalesce((p->>'sort')::int, 0))
  on conflict (id) do update set
    sport = excluded.sport, title = excluded.title, subtitle = excluded.subtitle,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, time_kind = excluded.time_kind,
    watch_label = excluded.watch_label, watch_url = excluded.watch_url,
    source_label = excluded.source_label, source_url = excluded.source_url,
    checked_at = excluded.checked_at, note = excluded.note,
    pick_enabled = excluded.pick_enabled, pick_question = excluded.pick_question,
    options = excluded.options, sort = excluded.sort;
end $$;

create or replace function public.admin_delete_event(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.events where id = p_id;
end $$;

create or replace function public.admin_set_result(p_event text, p_result text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  update public.events set result = nullif(p_result,'') where id = p_event;
end $$;

create or replace function public.admin_lock_picks(p_event text, p_locked boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  update public.events set picks_locked = p_locked where id = p_event;
end $$;

create or replace function public.admin_edit_participant(p_id uuid, p_name text, p_rsvp text, p_beach boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._require_admin();
  if exists (select 1 from public.participants where name_norm = public._norm(p_name) and id <> p_id) then
    raise exception 'NOME_EM_USO';
  end if;
  update public.participants set name = trim(p_name), name_norm = public._norm(p_name),
    rsvp = p_rsvp, plays_beach = p_beach, updated_at = now() where id = p_id;
end $$;

-- Desvincula o aparelho: a pessoa pode "assumir" o nome de novo em outro celular.
create or replace function public.admin_release_device(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.devices where participant_id = p_id;
end $$;

create or replace function public.admin_delete_participant(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.participants where id = p_id;
end $$;

-- Junta dois registros da mesma pessoa: mantém p_keep, apaga p_drop.
create or replace function public.admin_merge_participants(p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  if p_keep = p_drop then raise exception 'MESMO_REGISTRO'; end if;
  update public.items set participant_id = p_keep where participant_id = p_drop;
  insert into public.picks(participant_id, event_id, choice, updated_at)
    select p_keep, event_id, choice, updated_at from public.picks where participant_id = p_drop
    on conflict do nothing;
  insert into public.tv_votes(poll_id, participant_id, event_id, updated_at)
    select poll_id, p_keep, event_id, updated_at from public.tv_votes where participant_id = p_drop
    on conflict do nothing;
  update public.devices set participant_id = p_keep where participant_id = p_drop;
  delete from public.participants where id = p_drop;
end $$;

create or replace function public.admin_delete_item(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.items where id = p_id;
end $$;

create or replace function public.admin_upsert_poll(p_id text, p_title text, p_event_ids text[], p_closes_at timestamptz, p_locked boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  insert into public.tv_polls(id, title, event_ids, closes_at, locked)
  values (p_id, p_title, p_event_ids, p_closes_at, coalesce(p_locked,false))
  on conflict (id) do update set title = excluded.title, event_ids = excluded.event_ids,
    closes_at = excluded.closes_at, locked = excluded.locked;
end $$;

create or replace function public.admin_delete_poll(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  delete from public.tv_polls where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Execução: helpers internos fechados; funções públicas liberadas
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.whoami(text),
  public.join_or_update(text,text,text),
  public.set_beach(text,boolean),
  public.add_item(text,text,text,text),
  public.update_item(text,uuid,text,text,text),
  public.remove_item(text,uuid),
  public.set_pick(text,text,text),
  public.cast_tv_vote(text,text,text),
  public.am_i_admin()
to anon, authenticated;
grant execute on function
  public.admin_update_settings(text,text,text,text,text),
  public.admin_upsert_event(jsonb),
  public.admin_delete_event(text),
  public.admin_set_result(text,text),
  public.admin_lock_picks(text,boolean),
  public.admin_edit_participant(uuid,text,text,boolean),
  public.admin_release_device(uuid),
  public.admin_delete_participant(uuid),
  public.admin_merge_participants(uuid,uuid),
  public.admin_delete_item(uuid),
  public.admin_upsert_poll(text,text,text[],timestamptz,boolean),
  public.admin_delete_poll(text)
to authenticated;

-- ---------------------------------------------------------------------
-- Ranking: 3 pontos por palpite certo
-- ---------------------------------------------------------------------
create or replace view public.leaderboard with (security_invoker = on) as
select p.id, p.name,
       3 * count(*) filter (where e.result is not null and pk.choice = e.result) as points,
       count(*) filter (where e.result is not null and pk.choice = e.result)     as hits,
       count(*) filter (where e.result is not null)                               as decided,
       count(pk.event_id)                                                         as picks_count
  from public.participants p
  left join public.picks  pk on pk.participant_id = p.id
  left join public.events e  on e.id = pk.event_id
 group by p.id, p.name;
grant select on public.leaderboard to anon, authenticated;

-- ---------------------------------------------------------------------
-- Tempo real
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['settings','participants','events','items','picks','tv_polls','tv_votes'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Dados iniciais (rodar de novo não sobrescreve o que o organizador editou)
-- ---------------------------------------------------------------------
insert into public.settings(id) values (1) on conflict do nothing;

-- Eventos conferidos em 20/10/2026. Horários em Brasília (UTC-3).
-- watch_label nulo = "A confirmar" (sem fonte oficial para a transmissão no Brasil).
insert into public.events (id, sport, title, subtitle, starts_at, ends_at, time_kind,
  watch_label, watch_url, source_label, source_url, checked_at, note,
  pick_enabled, pick_question, options, sort) values
('eleicao', 'turma', 'Vote! 2º turno', 'Seções abertas das 8h às 17h (horário de Brasília)',
  '2026-10-25 08:00-03', '2026-10-25 17:00-03', 'confirmado',
  null, null, 'TSE', 'https://www.tse.jus.br/eleicoes/calendario-eleitoral', '2026-10-20',
  'Primeiro a urna, depois a resenha.', false, null, '[]', 1),
('almaty', 'tenis', 'Final do ATP 250 de Almaty', 'Finalistas a definir',
  '2026-10-25 07:00-03', null, 'nao_antes_de',
  'Tennis TV (streaming oficial da ATP)', 'https://www.tennistv.com', 'ATP Tour',
  'https://www.atptour.com/en/news/almaty-atp-250-2026-history-draw-schedule', '2026-10-20',
  'Não antes das 15h em Almaty (07h de Brasília) — acontece antes do encontro. Canal na TV brasileira a confirmar.',
  true, 'Quem vence a final?', '[]', 2),
('nfl-paris', 'nfl', 'Steelers x Saints', 'NFL · Semana 7 · Jogo em Paris (Stade de France)',
  '2026-10-25 10:30-03', null, 'confirmado',
  'NFL Game Pass', 'https://www.dazn.com', 'NFL.com',
  'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20',
  'Canal na TV brasileira a confirmar.', false, null, '[]', 3),
('nfl-14h', 'nfl', 'NFL · rodada das 14h', '49ers x Falcons · Bengals x Ravens · Buccaneers x Panthers · Giants x Texans · Colts x Vikings · Dolphins x Jets · Browns x Titans',
  '2026-10-25 14:00-03', null, 'confirmado',
  'NFL Game Pass', 'https://www.dazn.com', 'NFL.com',
  'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20',
  'Canal de cada jogo na TV brasileira a confirmar.', false, null, '[]', 4),
('beach', 'turma', 'Beach tennis da turma', 'Clube Hípico de Santo Amaro',
  '2026-10-25 11:00-03', '2026-10-25 13:00-03', 'confirmado',
  null, null, null, null, null,
  'Antes do almoço: vote cedo (seções abrem às 8h). Confirmar entrada de convidados e reserva da quadra com o clube.',
  false, null, '[]', 5),
('f1-eua', 'f1', 'GP dos Estados Unidos', 'Fórmula 1 · Circuito das Américas, Austin',
  '2026-10-25 17:00-03', '2026-10-25 19:00-03', 'confirmado',
  null, null, 'Formula1.com',
  'https://www.formula1.com/en/latest/article/formula-1-msc-cruises-united-states-grand-prix-2026.2u6li2pzNhPzL3TSYaagrm', '2026-10-20',
  'Transmissão no Brasil é do Grupo Globo; imprensa indica SporTV e Globoplay (Globo aberta não confirmada).',
  true, 'Quem vence o GP?',
  '["Lando Norris","Oscar Piastri","Max Verstappen","Isack Hadjar","Charles Leclerc","Lewis Hamilton","George Russell","Kimi Antonelli","Fernando Alonso","Lance Stroll","Pierre Gasly","Franco Colapinto","Carlos Sainz","Alexander Albon","Liam Lawson","Arvid Lindblad","Esteban Ocon","Oliver Bearman","Nico Hülkenberg","Gabriel Bortoleto","Sergio Pérez","Valtteri Bottas"]',
  6),
('classico', 'futebol', 'Barcelona x Real Madrid', 'LaLiga · 10ª rodada · Spotify Camp Nou',
  '2026-10-25 17:00-03', '2026-10-25 18:55-03', 'confirmado',
  null, null, 'FC Barcelona',
  'https://www.fcbarcelona.es/es/noticias/4570226/el-horario-del-clasico-de-liga-en-el-spotify-camp-nou-confirmado', '2026-10-20',
  '21h na Espanha. Direitos da LaLiga no Brasil: CazéTV (laliga.com). Canal deste jogo a confirmar.',
  true, 'Qual o resultado?', '["Barcelona","Empate","Real Madrid"]', 7),
('nfl-tarde', 'nfl', 'NFL · jogos da tarde', '17h05 Broncos x Cardinals · 17h25 Packers x Lions · 17h25 Rams x Raiders',
  '2026-10-25 17:05-03', null, 'confirmado',
  'NFL Game Pass', 'https://www.dazn.com', 'NFL.com',
  'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20',
  'Canal de cada jogo na TV brasileira a confirmar.', false, null, '[]', 8),
('nfl-snf', 'nfl', 'Chiefs x Seahawks', 'NFL · Sunday Night Football · Lumen Field',
  '2026-10-25 21:20-03', null, 'confirmado',
  'NFL Game Pass', 'https://www.dazn.com', 'NFL.com',
  'https://www.nfl.com/schedules/2026/by-week/reg-7', '2026-10-20',
  'Canal na TV brasileira a confirmar. Jogo noturno pode mudar (flex da NFL).',
  true, 'Quem vence?', '["Chiefs","Seahawks"]', 9)
on conflict (id) do nothing;

insert into public.tv_polls (id, title, event_ids, closes_at, locked) values
('tv-17h', '17h: o que vai na TV principal?', array['f1-eua','classico','nfl-tarde'], null, false)
on conflict (id) do nothing;


-- ===== Ajustes de 20/10/2026 (mesmo conteúdo de migration-2026-10-20.sql) =====
-- =====================================================================
-- Migração 20/10/2026 — rode no SQL Editor DEPOIS do schema.sql.
-- Pode rodar mais de uma vez.
-- 1) Palpites alheios só ficam visíveis depois do fechamento (no banco, não só na tela)
-- 2) Organizador pode fechar inscrições de nomes novos
-- 3) Horário "proposto" (ex.: beach tennis aguardando o clube)
-- 4) Ajustes de dados: transmissões pagas, Almaty fora do ranking, prazo da votação da TV
-- =====================================================================

-- 1) Palpites -----------------------------------------------------------
revoke select on public.picks from anon, authenticated;
drop policy if exists leitura_publica on public.picks;

do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'picks') then
    alter publication supabase_realtime drop table public.picks;
  end if;
end $$;

create or replace function public._picks_closed(e public.events) returns boolean
language sql stable as $$
  select e.picks_locked or e.result is not null or (e.starts_at is not null and now() >= e.starts_at)
$$;

-- Seus palpites + palpites de todos nos eventos já fechados.
create or replace function public.visible_picks(p_token text)
returns table (participant_id uuid, event_id text, choice text)
language sql stable security definer set search_path = public, extensions as $$
  select pk.participant_id, pk.event_id, pk.choice
    from public.picks pk join public.events e on e.id = pk.event_id
   where pk.participant_id = public._me(p_token) or public._picks_closed(e)
$$;

-- Quantas pessoas palpitaram em cada evento (sem revelar as escolhas).
create or replace function public.pick_counts()
returns table (event_id text, n bigint)
language sql stable security definer set search_path = public as $$
  select event_id, count(*) from public.picks group by event_id
$$;

create or replace function public.server_now() returns timestamptz
language sql stable as $$ select now() $$;

-- Ranking roda com o dono da view: lê picks sem expor as escolhas.
drop view if exists public.leaderboard;
create view public.leaderboard as
select p.id, p.name,
       3 * count(*) filter (where e.result is not null and pk.choice = e.result) as points,
       count(*) filter (where e.result is not null and pk.choice = e.result)     as hits,
       count(*) filter (where e.result is not null)                               as decided,
       count(pk.event_id)                                                         as picks_count
  from public.participants p
  left join public.picks  pk on pk.participant_id = p.id
  left join public.events e  on e.id = pk.event_id
 group by p.id, p.name;
grant select on public.leaderboard to anon, authenticated;

-- 2) Inscrições ---------------------------------------------------------
alter table public.settings add column if not exists signups_open boolean not null default true;

create or replace function public.join_or_update(p_token text, p_name text, p_rsvp text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_me    uuid := public._me(p_token);
  v_name  text := regexp_replace(trim(coalesce(p_name,'')), '\s+', ' ', 'g');
  v_norm  text := public._norm(p_name);
  v_other uuid;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'NOME_INVALIDO';
  end if;
  if p_rsvp not in ('sim','talvez','nao') then raise exception 'RSVP_INVALIDO'; end if;

  select id into v_other from public.participants where name_norm = v_norm;

  if v_me is null then
    if v_other is not null then
      if exists (select 1 from public.devices where participant_id = v_other) then
        raise exception 'NOME_EM_USO';
      end if;
      insert into public.devices(device_hash, participant_id) values (public._hash(p_token), v_other);
      update public.participants set rsvp = p_rsvp, name = v_name, updated_at = now() where id = v_other;
      return v_other;
    end if;
    if not coalesce((select signups_open from public.settings where id = 1), true) then
      raise exception 'INSCRICOES_FECHADAS';
    end if;
    if (select count(*) from public.participants) >= 150 then raise exception 'LISTA_CHEIA'; end if;
    insert into public.participants(name, name_norm, rsvp) values (v_name, v_norm, p_rsvp)
      returning id into v_me;
    insert into public.devices(device_hash, participant_id) values (public._hash(p_token), v_me);
    return v_me;
  end if;

  if v_other is not null and v_other <> v_me then raise exception 'NOME_EM_USO'; end if;
  update public.participants
     set name = v_name, name_norm = v_norm, rsvp = p_rsvp, updated_at = now()
   where id = v_me;
  return v_me;
end $$;

create or replace function public.admin_set_signups(p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  update public.settings set signups_open = coalesce(p_open, true), updated_at = now() where id = 1;
end $$;

-- 3) Horário proposto ---------------------------------------------------
alter table public.events drop constraint if exists events_time_kind_check;
alter table public.events add constraint events_time_kind_check
  check (time_kind in ('confirmado','nao_antes_de','a_confirmar','proposto'));

-- Permissões das funções novas -------------------------------------------
revoke execute on function public._picks_closed(public.events) from public, anon, authenticated;
grant execute on function public.visible_picks(text), public.pick_counts(), public.server_now(),
  public.join_or_update(text,text,text) to anon, authenticated;
revoke execute on function public.admin_set_signups(boolean) from public, anon;
grant execute on function public.admin_set_signups(boolean) to authenticated;

-- 4) Dados ---------------------------------------------------------------
update public.events set time_kind = 'proposto' where id = 'beach' and time_kind = 'confirmado';
update public.events set watch_label = 'NFL Game Pass (pago)' where watch_label = 'NFL Game Pass';
update public.events set watch_label = 'Tennis TV (oficial da ATP, pago)'
 where id = 'almaty' and watch_label = 'Tennis TV (streaming oficial da ATP)';
update public.events set pick_enabled = false where id = 'almaty' and pick_enabled
  and not exists (select 1 from public.picks where event_id = 'almaty');
update public.events set pick_question = 'Quem vence? Ou dá empate?'
 where id = 'classico' and pick_question = 'Qual o resultado?';
update public.tv_polls set closes_at = '2026-10-25 17:00-03' where id = 'tv-17h' and closes_at is null;


-- ===== Ajustes 20/10/2026 (b) (mesmo conteúdo de migration-2026-10-20b.sql) =====
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
