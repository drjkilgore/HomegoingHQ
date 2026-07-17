-- HomegoingHQ — Migration v17: Concierge notes / next-step nudges
-- A concierge with an ACTIVE progress-only link can leave short notes and
-- next-step nudges the family sees on their estate. Notes are text the concierge
-- writes — they never grant the concierge any read access to documents/ledger.
-- The family can mark a nudge done; only the authoring concierge can edit/delete.
--
-- Requires migration v16 (estate_concierge_links). Idempotent.

-- ── helper: does the caller have an active concierge link to this estate? ────
create or replace function public.has_active_concierge_link(e uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.estate_concierge_links
     where estate_id = e and concierge_id = auth.uid() and status = 'active'
  );
$$;

-- ── table ────────────────────────────────────────────────────────────────────
create table if not exists public.concierge_notes (
  id          uuid primary key default gen_random_uuid(),
  estate_id   uuid not null references public.estates(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null,
  done        boolean not null default false,   -- family can mark a nudge handled
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists idx_cnote_estate on public.concierge_notes(estate_id);

alter table public.concierge_notes enable row level security;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Read: the family (estate members) and the authoring concierge.
drop policy if exists cnote_read on public.concierge_notes;
create policy cnote_read on public.concierge_notes
  for select
  using (public.is_estate_member(estate_id) or author_id = auth.uid());

-- Write: only a concierge with an ACTIVE link, as themselves.
drop policy if exists cnote_insert on public.concierge_notes;
create policy cnote_insert on public.concierge_notes
  for insert
  with check (author_id = auth.uid() and public.has_active_concierge_link(estate_id));

-- Edit/delete: author (the concierge) only. Family toggles `done` via the RPC
-- below (so they can't rewrite the note body).
drop policy if exists cnote_update on public.concierge_notes;
create policy cnote_update on public.concierge_notes
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists cnote_delete on public.concierge_notes;
create policy cnote_delete on public.concierge_notes
  for delete using (author_id = auth.uid());

-- ── family: mark a nudge done / not done ─────────────────────────────────────
create or replace function public.concierge_note_set_done(p_note uuid, p_done boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare e uuid;
begin
  select estate_id into e from public.concierge_notes where id = p_note;
  if e is null then return false; end if;
  if not public.is_estate_member(e) then
    raise exception 'not authorized for this estate';
  end if;
  update public.concierge_notes
     set done = p_done, done_at = case when p_done then now() else null end
   where id = p_note;
  return true;
end;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────
revoke all on function public.has_active_concierge_link(uuid)       from public;
revoke all on function public.concierge_note_set_done(uuid, boolean) from public;
grant execute on function public.has_active_concierge_link(uuid)       to authenticated;
grant execute on function public.concierge_note_set_done(uuid, boolean) to authenticated;
