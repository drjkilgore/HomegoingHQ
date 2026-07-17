-- HomegoingHQ — Migration v20: Per-ESTATE entitlement (Settle/Companion per estate)
-- Moves the paid tier from the person (profiles.plan_tier) to the estate
-- (estates.tier). Each estate starts 'free' and is upgraded on its own.
-- Premium stays a per-user subscription; the app resolves the effective tier as
-- the HIGHER of the estate's tier and the person's profile tier (so Premium
-- subscribers, and the concierge free-Settle perk, still work).
-- Idempotent.

-- ── 1. Columns on estates ────────────────────────────────────────────────────
alter table public.estates add column if not exists tier    text not null default 'free';
alter table public.estates add column if not exists ai_uses int  not null default 0;

-- ── 2. Grandfather existing paid families, then close the per-user loophole ───
-- (a) stamp each paid family's OWN estates with what they already paid for,
--     so nobody loses access. Concierges are excluded (their profile Settle is
--     an intentional perk that already grants all their estates via the max()).
update public.estates e
   set tier = p.plan_tier
  from public.profiles p
 where e.created_by = p.id
   and p.plan_tier in ('companion','settle')
   and not exists (select 1 from public.concierge_accounts c where c.owner_user_id = p.id);

-- (b) reset those profiles to free so they can't spin up unlimited free estates.
--     Premium (subscription) and concierge (perk) profiles are left as-is.
update public.profiles p
   set plan_tier = 'free'
 where p.plan_tier in ('companion','settle')
   and not exists (select 1 from public.concierge_accounts c where c.owner_user_id = p.id);

-- ── 3. Guard: authenticated users cannot self-change an estate's tier/ai_uses ─
-- estates rows are updatable by members (editing decedent info, etc.). Without
-- this, a member could PATCH tier='settle' or reset ai_uses. The Stripe webhook
-- (service role, auth.uid() IS NULL) and the AI-increment RPC (sets a local
-- bypass flag) are allowed through.
create or replace function public.estates_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.estate_bypass', true),'') = 'on' then return new; end if;
  if auth.uid() is not null and not public.is_admin() then
    new.tier    := old.tier;      -- only admins / webhook change tier
    new.ai_uses := old.ai_uses;   -- only the increment RPC changes usage
  end if;
  return new;
end;
$$;

drop trigger if exists trg_estates_guard on public.estates;
create trigger trg_estates_guard before update on public.estates
  for each row execute function public.estates_guard();

-- ── 4. Estate-aware AI usage counter ─────────────────────────────────────────
-- When called with an estate, count against estates.ai_uses; otherwise fall back
-- to the legacy per-profile counter (e.g. life-plan context). Returns new count.
create or replace function public.increment_ai_use(p_estate uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_estate is not null then
    -- must be a member of that estate
    if not public.is_estate_member(p_estate) then
      raise exception 'not authorized for this estate';
    end if;
    perform set_config('app.estate_bypass','on', true);   -- allow the guarded write
    update public.estates set ai_uses = coalesce(ai_uses,0) + 1
     where id = p_estate returning ai_uses into n;
    return coalesce(n,0);
  else
    update public.profiles set ai_uses = coalesce(ai_uses,0) + 1
     where id = auth.uid() returning ai_uses into n;
    return coalesce(n,0);
  end if;
end;
$$;

revoke all on function public.increment_ai_use(uuid) from public;
grant execute on function public.increment_ai_use(uuid) to authenticated;
