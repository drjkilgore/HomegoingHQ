-- HomegoingHQ — Migration v21: Per-estate gift credits
-- A redeemed gift no longer upgrades the whole person. It banks ONE Settle
-- credit, which the family spends to unlock a single estate of their choice.
-- Matches per-estate pricing and the common case where a gift is redeemed
-- BEFORE the estate exists. Idempotent.

-- ── 1. Credit balance on the profile ─────────────────────────────────────────
alter table public.profiles add column if not exists settle_credits int not null default 0;

-- ── 2. redeem_gift → bank a credit instead of setting plan_tier ───────────────
create or replace function public.redeem_gift(gcode text)
returns json language plpgsql security definer set search_path = public as $function$
declare g record;
begin
  if auth.uid() is null then return json_build_object('error','Sign in first.'); end if;
  select * into g from public.gift_codes
   where upper(code)=upper(trim(gcode)) and status='active' limit 1;
  if g is null then return json_build_object('error','That code isn''t valid or was already used.'); end if;

  -- bank one credit (the gift's tier; settle for the standard gift)
  update public.profiles
     set settle_credits = coalesce(settle_credits,0) + 1
   where id = auth.uid();

  update public.gift_codes
     set status='redeemed', redeemed_by=auth.uid(), redeemed_at=now()
   where id = g.id;

  return json_build_object('ok', true, 'tier', g.tier, 'credited', true,
    'credits', (select settle_credits from public.profiles where id = auth.uid()));
end $function$;

-- ── 3. Spend a credit to unlock one estate ───────────────────────────────────
create or replace function public.claim_estate_credit(p_estate uuid)
returns json language plpgsql security definer set search_path = public as $function$
declare c int; cur text;
begin
  if not public.is_estate_member(p_estate) then
    return json_build_object('error','You are not a member of this estate.');
  end if;
  select coalesce(settle_credits,0) into c from public.profiles where id = auth.uid();
  if c < 1 then return json_build_object('error','You don''t have a gift credit to use.'); end if;

  select tier into cur from public.estates where id = p_estate;
  if cur = 'settle' then return json_build_object('error','This estate is already unlocked.'); end if;

  -- spend the credit and unlock the estate (guard bypass, like the webhook path)
  update public.profiles set settle_credits = settle_credits - 1 where id = auth.uid();
  perform set_config('app.estate_bypass','on', true);
  update public.estates set tier = 'settle' where id = p_estate;

  return json_build_object('ok', true, 'tier', 'settle',
    'credits', (select settle_credits from public.profiles where id = auth.uid()));
end $function$;

revoke all on function public.claim_estate_credit(uuid) from public;
grant execute on function public.claim_estate_credit(uuid) to authenticated;
