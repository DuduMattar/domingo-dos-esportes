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
