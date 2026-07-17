-- HomegoingHQ — Migration v16: Progress-only concierge links
-- Lets a family share a COMPLETION CHECKLIST with a concierge WITHOUT giving
-- any access to documents, ledger, probate, assets, or task detail.
--
-- Privacy model:
--   * The concierge is NEVER added to estate_members, so every existing RLS
--     policy that gates documents/assets/etc on is_estate_member() already
--     excludes them by construction.
--   * The ONLY thing a concierge can read about a linked estate is the output
--     of concierge_client_progress(), a SECURITY DEFINER function that returns
--     phase/category done-counts, a document COUNT (never names or paths), and
--     the titles of STANDARD (non-custom) upcoming tasks only. Family free-text
--     (custom task titles) never leaves the estate.
--   * The family holds the switch: they create the link and can revoke it any
--     time. Revoked/declined links return nothing.
--
-- Idempotent. Safe to re-run.

-- ── 1. Link table ───────────────────────────────────────────────────────────
create table if not exists public.estate_concierge_links (
  id            uuid primary key default gen_random_uuid(),
  estate_id     uuid not null references public.estates(id) on delete cascade,
  concierge_id  uuid references public.profiles(id) on delete set null,  -- null until accepted
  email         text not null,                       -- invited email (lowercased)
  status        text not null default 'invited',     -- invited | active | revoked | declined
  scope         text not null default 'progress_only', -- reserved for future scopes
  invited_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  unique (estate_id, email)
);

create index if not exists idx_ecl_estate    on public.estate_concierge_links(estate_id);
create index if not exists idx_ecl_concierge on public.estate_concierge_links(concierge_id);
create index if not exists idx_ecl_email      on public.estate_concierge_links(lower(email));

alter table public.estate_concierge_links enable row level security;

-- ── 2. RLS ──────────────────────────────────────────────────────────────────
-- Family (any member of the estate) fully manages that estate's links.
drop policy if exists ecl_family_all on public.estate_concierge_links;
create policy ecl_family_all on public.estate_concierge_links
  for all
  using (public.is_estate_member(estate_id))
  with check (public.is_estate_member(estate_id));

-- Concierge can READ links that are theirs: already accepted (concierge_id),
-- or still addressed to their email (so they can see/accept a pending invite).
drop policy if exists ecl_concierge_read on public.estate_concierge_links;
create policy ecl_concierge_read on public.estate_concierge_links
  for select
  using (
    concierge_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- Note: the concierge does NOT get UPDATE via RLS. Accepting/declining goes
-- through accept_concierge_link() (SECURITY DEFINER) so we control the fields.

-- ── 3. Family: invite a concierge (progress only) ────────────────────────────
create or replace function public.invite_concierge_progress(p_estate uuid, p_email text)
returns public.estate_concierge_links
language plpgsql security definer set search_path = public as $$
declare r public.estate_concierge_links;
begin
  if not public.is_estate_member(p_estate) then
    raise exception 'not authorized for this estate';
  end if;
  if coalesce(p_email,'') = '' or position('@' in p_email) = 0 then
    raise exception 'valid email required';
  end if;

  insert into public.estate_concierge_links (estate_id, email, invited_by, status)
  values (p_estate, lower(trim(p_email)), auth.uid(), 'invited')
  on conflict (estate_id, email) do update
    set status = 'invited', responded_at = null
  returning * into r;

  return r;
end;
$$;

-- ── 4. Family: revoke a link ─────────────────────────────────────────────────
create or replace function public.revoke_concierge_link(p_link uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare e uuid;
begin
  select estate_id into e from public.estate_concierge_links where id = p_link;
  if e is null then return false; end if;
  if not public.is_estate_member(e) then
    raise exception 'not authorized for this estate';
  end if;
  update public.estate_concierge_links
     set status = 'revoked', responded_at = now()
   where id = p_link;
  return true;
end;
$$;

-- ── 5. Concierge: accept (or decline) an invite addressed to them ────────────
create or replace function public.accept_concierge_link(p_link uuid, p_accept boolean default true)
returns boolean
language plpgsql security definer set search_path = public as $$
declare r public.estate_concierge_links; myemail text;
begin
  select lower(coalesce(auth.jwt() ->> 'email','')) into myemail;
  select * into r from public.estate_concierge_links where id = p_link;
  if r.id is null then return false; end if;

  -- may accept if it's already yours, or still addressed to your email
  if not (r.concierge_id = auth.uid() or lower(r.email) = myemail) then
    raise exception 'this invite is not addressed to you';
  end if;
  if r.status = 'revoked' then
    raise exception 'this invite was revoked';
  end if;

  update public.estate_concierge_links
     set concierge_id = auth.uid(),
         status       = case when p_accept then 'active' else 'declined' end,
         responded_at = now()
   where id = p_link;
  return true;
end;
$$;

-- ── 6. Concierge: progress-only snapshot of all their active clients ─────────
-- Returns a jsonb array. NEVER returns document names/paths, asset values,
-- ledger, probate, or custom (family-authored) task titles.
create or replace function public.concierge_client_progress()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare out jsonb := '[]'::jsonb; lnk record;
begin
  for lnk in
    select l.id as link_id, l.estate_id, e.decedent_name, e.date_of_death, e.state_code
      from public.estate_concierge_links l
      join public.estates e on e.id = l.estate_id
     where l.concierge_id = auth.uid()
       and l.status = 'active'
     order by e.created_at desc
  loop
    out := out || jsonb_build_array(jsonb_build_object(
      'link_id',        lnk.link_id,
      'estate_id',      lnk.estate_id,
      'decedent_name',  lnk.decedent_name,
      'date_of_death',  lnk.date_of_death,
      'state_code',     lnk.state_code,

      -- overall
      'tasks_total', (select count(*) from public.tasks t where t.estate_id = lnk.estate_id and t.status <> 'na'),
      'tasks_done',  (select count(*) from public.tasks t where t.estate_id = lnk.estate_id and t.status = 'done'),

      -- per-phase done/total (na excluded from total)
      'phases', (
        select coalesce(jsonb_object_agg(ph, cnt), '{}'::jsonb)
        from (
          select coalesce(phase,'other') ph,
                 jsonb_build_object(
                   'total', count(*) filter (where status <> 'na'),
                   'done',  count(*) filter (where status = 'done')
                 ) cnt
          from public.tasks
          where estate_id = lnk.estate_id
          group by coalesce(phase,'other')
        ) s
      ),

      -- document COUNT only — never names or storage paths
      'documents_count', (select count(*) from public.documents d where d.estate_id = lnk.estate_id),

      -- next up: STANDARD roadmap tasks only (custom = false) so family
      -- free-text never leaks; titles of generated tasks are generic steps
      'next_up', (
        select coalesce(jsonb_agg(jsonb_build_object('title', title, 'due_at', due_at) order by due_at nulls last), '[]'::jsonb)
        from (
          select title, due_at
          from public.tasks
          where estate_id = lnk.estate_id and status = 'todo' and custom = false
          order by due_at nulls last
          limit 5
        ) n
      ),
      'custom_open', (select count(*) from public.tasks t where t.estate_id = lnk.estate_id and t.status = 'todo' and t.custom = true),

      'last_activity', (select max(updated_at) from public.tasks t where t.estate_id = lnk.estate_id)
    ));
  end loop;

  return out;
end;
$$;

-- ── 7. Grants ────────────────────────────────────────────────────────────────
revoke all on function public.invite_concierge_progress(uuid, text) from public;
revoke all on function public.revoke_concierge_link(uuid)            from public;
revoke all on function public.accept_concierge_link(uuid, boolean)   from public;
revoke all on function public.concierge_client_progress()            from public;

grant execute on function public.invite_concierge_progress(uuid, text) to authenticated;
grant execute on function public.revoke_concierge_link(uuid)            to authenticated;
grant execute on function public.accept_concierge_link(uuid, boolean)   to authenticated;
grant execute on function public.concierge_client_progress()            to authenticated;
