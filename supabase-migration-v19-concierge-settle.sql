-- HomegoingHQ — Migration v19: Concierge own-affairs entitlement (free Settle)
-- A concierge gets Settle-level access to THEIR OWN personal family workspace,
-- as a perk of holding a concierge account. This sets the FAMILY tier
-- (profiles.plan_tier), which is the only value tier() reads. It does NOT touch
-- the concierge SaaS tier (concierge_accounts.tier = starter/professional/...).
--
-- Upgrade-only: never downgrades someone who already paid for a higher tier.
-- Idempotent.

-- ── 1. Backfill existing concierges ──────────────────────────────────────────
update public.profiles p
   set plan_tier = 'settle'
  from public.concierge_accounts c
 where c.owner_user_id = p.id
   and p.plan_tier in ('free','companion');

-- ── 2. Auto-grant on new concierge accounts ──────────────────────────────────
create or replace function public.grant_concierge_settle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set plan_tier = 'settle'
   where id = new.owner_user_id
     and plan_tier in ('free','companion');   -- upgrade only
  return new;
end;
$$;

drop trigger if exists trg_concierge_settle on public.concierge_accounts;
create trigger trg_concierge_settle
  after insert on public.concierge_accounts
  for each row execute function public.grant_concierge_settle();

-- ── 3. Verify (optional) ─────────────────────────────────────────────────────
-- select p.email, p.plan_tier
-- from public.profiles p
-- join public.concierge_accounts c on c.owner_user_id = p.id;
