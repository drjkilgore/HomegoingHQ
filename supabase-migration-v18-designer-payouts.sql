-- HomegoingHQ — Migration v18: Designer payouts (Option B) + onboarding
-- Adds a payout ledger (designer keeps a share of the DESIGN FEE only, credited
-- when the family's printing balance is paid), designer onboarding fields
-- (signed agreement + payout method; W-9 already exists as designers.w9_doc),
-- and a guard so designers can't change their own pay rate or approval status.
-- Idempotent.

-- ── 1. Designer onboarding + payout-rate columns ─────────────────────────────
alter table public.designers add column if not exists payout_rate         numeric not null default 0.70;
alter table public.designers add column if not exists agreement_version   text;
alter table public.designers add column if not exists agreement_signed_at timestamptz;
alter table public.designers add column if not exists agreement_signed_name text;
alter table public.designers add column if not exists agreement_ua        text;
alter table public.designers add column if not exists agreement_doc       text;   -- optional uploaded signed copy (designer-private)
alter table public.designers add column if not exists w9_uploaded_at      timestamptz;
alter table public.designers add column if not exists payout_method       text;   -- zelle | paypal | venmo | ach | check
alter table public.designers add column if not exists payout_handle       text;   -- email/phone/etc for manual payout
alter table public.designers add column if not exists onboarded_at        timestamptz;

-- ── 2. Privilege guard: non-admins cannot self-change rate/status/featured ───
-- designers rows are self-writable (the application flow upserts them), so
-- without this a designer could PATCH their own payout_rate or approve
-- themselves. Admins are unaffected.
create or replace function public.designers_guard_ins()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.status      := 'pending';
    new.featured    := false;
    new.payout_rate := 0.70;
    new.onboarded_at := null;
  end if;
  return new;
end; $$;

create or replace function public.designers_guard_upd()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.status      := old.status;       -- can't self-approve
    new.featured    := old.featured;     -- can't self-feature
    new.payout_rate := old.payout_rate;  -- can't set own pay rate
  end if;
  return new;
end; $$;

drop trigger if exists trg_designers_guard_ins on public.designers;
create trigger trg_designers_guard_ins before insert on public.designers
  for each row execute function public.designers_guard_ins();

drop trigger if exists trg_designers_guard_upd on public.designers;
create trigger trg_designers_guard_upd before update on public.designers
  for each row execute function public.designers_guard_upd();

-- ── 3. Payout ledger ─────────────────────────────────────────────────────────
create table if not exists public.designer_payouts (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null unique references public.fullservice_requests(id) on delete cascade,
  designer_id  uuid references public.designers(id) on delete set null,
  design_fee   numeric not null default 0,   -- gross design fee (dollars)
  rate         numeric not null default 0.70, -- designer share at time of credit
  amount       numeric not null default 0,    -- design_fee * rate, owed to designer
  status       text not null default 'owed',  -- owed | paid
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  paid_method  text,
  paid_ref     text,
  note         text
);
create index if not exists idx_dpayout_designer on public.designer_payouts(designer_id);
create index if not exists idx_dpayout_status   on public.designer_payouts(status);

alter table public.designer_payouts enable row level security;

-- Designer reads their own payouts; admins read all. Inserts happen server-side
-- (Stripe webhook, service role, bypasses RLS). Updates go through the RPC.
drop policy if exists dpayout_read on public.designer_payouts;
create policy dpayout_read on public.designer_payouts
  for select using (
    public.is_admin()
    or exists (select 1 from public.designers d where d.id = designer_id and d.user_id = auth.uid())
  );

-- ── 4. Admin: mark a payout paid ─────────────────────────────────────────────
create or replace function public.mark_payout_paid(p_payout uuid, p_method text, p_ref text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.designer_payouts
     set status = 'paid', paid_at = now(), paid_method = p_method, paid_ref = p_ref
   where id = p_payout;
  return true;
end; $$;

create or replace function public.mark_payout_unpaid(p_payout uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.designer_payouts
     set status = 'owed', paid_at = null, paid_method = null, paid_ref = null
   where id = p_payout;
  return true;
end; $$;

revoke all on function public.mark_payout_paid(uuid, text, text) from public;
revoke all on function public.mark_payout_unpaid(uuid)           from public;
grant execute on function public.mark_payout_paid(uuid, text, text) to authenticated;
grant execute on function public.mark_payout_unpaid(uuid)           to authenticated;
