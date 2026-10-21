-- =====================================================================
-- Migração 21/10/2026 (b) — ficha do evento (dados conferidos, com fonte)
-- Pode rodar mais de uma vez.
-- =====================================================================
alter table public.events add column if not exists facts jsonb not null default '[]'::jsonb;

create or replace function public.admin_upsert_event(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  insert into public.events as e (id, sport, title, subtitle, starts_at, ends_at, time_kind,
    watch_label, watch_url, source_label, source_url, checked_at, note,
    pick_enabled, pick_question, options, sort, in_agenda, facts)
  values (
    p->>'id', p->>'sport', p->>'title', nullif(p->>'subtitle',''),
    nullif(p->>'starts_at','')::timestamptz, nullif(p->>'ends_at','')::timestamptz,
    coalesce(nullif(p->>'time_kind',''),'confirmado'),
    nullif(p->>'watch_label',''), nullif(p->>'watch_url',''),
    nullif(p->>'source_label',''), nullif(p->>'source_url',''),
    nullif(p->>'checked_at','')::date, nullif(p->>'note',''),
    coalesce((p->>'pick_enabled')::boolean, false), nullif(p->>'pick_question',''),
    coalesce(p->'options','[]'::jsonb), coalesce((p->>'sort')::int, 0),
    coalesce((p->>'in_agenda')::boolean, true), coalesce(p->'facts','[]'::jsonb))
  on conflict (id) do update set
    sport = excluded.sport, title = excluded.title, subtitle = excluded.subtitle,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, time_kind = excluded.time_kind,
    watch_label = excluded.watch_label, watch_url = excluded.watch_url,
    source_label = excluded.source_label, source_url = excluded.source_url,
    checked_at = excluded.checked_at, note = excluded.note,
    pick_enabled = excluded.pick_enabled, pick_question = excluded.pick_question,
    options = excluded.options, sort = excluded.sort, in_agenda = excluded.in_agenda,
    facts = excluded.facts;
end $$;
revoke execute on function public.admin_upsert_event(jsonb) from public, anon;
grant execute on function public.admin_upsert_event(jsonb) to authenticated;
