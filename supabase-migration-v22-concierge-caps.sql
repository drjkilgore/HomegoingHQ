-- HomegoingHQ — Migration v22: Concierge tier caps = 50 / 100 / 200 / 400
-- default_estate_limit(tier) is the single source of truth for how many active
-- families each concierge tier allows; provision_concierge_account() reads it.
-- This resets the numbers and backfills existing accounts so displayed caps
-- (Starter 50, Professional 100, Enterprise 200, Agency 400) match what's enforced.
-- Idempotent.

-- 1) The cap map
create or replace function public.default_estate_limit(t text)
returns integer language sql immutable set search_path = public as $$
  select case lower(coalesce(t,''))
    when 'starter'      then 50
    when 'professional' then 100
    when 'enterprise'   then 200
    when 'agency'       then 400
    else 50
  end;
$$;

-- 2) Backfill existing concierge accounts to the new caps for their current tier
update public.concierge_accounts
   set estate_limit = public.default_estate_limit(tier),
       updated_at   = now()
 where estate_limit is distinct from public.default_estate_limit(tier);

-- 3) Verify (optional)
-- select tier, estate_limit, count(*) from public.concierge_accounts group by tier, estate_limit order by tier;
