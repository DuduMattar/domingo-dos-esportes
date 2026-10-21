-- =====================================================================
-- Migração 21/10/2026 — link pessoal de entrada + quem já palpitou
-- Rode no SQL Editor. Pode rodar mais de uma vez.
-- =====================================================================

-- Link pessoal: um código por participante, sem leitura pública.
create table if not exists public.login_links (
  participant_id uuid primary key references public.participants(id) on delete cascade,
  code           text not null unique,
  created_at     timestamptz not null default now()
);
alter table public.login_links enable row level security;
revoke all on public.login_links from anon, authenticated;

-- Organizador pega o código da pessoa (cria se não existir; p_new = true troca o código e invalida o link antigo).
create or replace function public.admin_get_link(p_id uuid, p_new boolean default false) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  perform public._require_admin();
  if p_new then delete from public.login_links where participant_id = p_id; end if;
  select code into v from public.login_links where participant_id = p_id;
  if v is null then
    v := encode(extensions.gen_random_bytes(12), 'hex');
    insert into public.login_links(participant_id, code) values (p_id, v);
  end if;
  return v;
end $$;

-- Quem abre o link entra como a pessoa neste navegador (vários navegadores podem usar o mesmo link).
create or replace function public.redeem_link(p_token text, p_code text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  select participant_id into v from public.login_links where code = lower(trim(p_code));
  if v is null then raise exception 'LINK_INVALIDO'; end if;
  insert into public.devices(device_hash, participant_id) values (public._hash(p_token), v)
  on conflict (device_hash) do update set participant_id = excluded.participant_id;
  return v;
end $$;

-- Quem já palpitou em cada evento (só nomes; a escolha continua escondida até fechar).
create or replace function public.pick_people()
returns table (event_id text, participant_id uuid)
language sql stable security definer set search_path = public as $$
  select event_id, participant_id from public.picks
$$;

revoke execute on function public.admin_get_link(uuid, boolean) from public, anon;
grant execute on function public.admin_get_link(uuid, boolean) to authenticated;
revoke execute on function public.redeem_link(text, text), public.pick_people() from public;
grant execute on function public.redeem_link(text, text), public.pick_people() to anon, authenticated;
