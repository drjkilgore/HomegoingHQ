-- HomegoingHQ — Migration v27: fix subdomain/domain cleaning (lowercase, THEN strip)
-- Bug: every subdomain/domain cleaner ran regexp_replace([^a-z0-9-]) BEFORE lower(),
-- so any UPPERCASE letter was DELETED instead of lowercased. On mobile, auto-
-- capitalization turned "Test Funeral Home" into subdomain "estuneralome" (the T,
-- F, H were stripped). Fix: lowercase first, then strip. Verbatim copies of the
-- live functions with only that one reordering. Idempotent.

-- 1) admin-side co-brand provisioning
create or replace function public.admin_provision_partner(
  p_owner_email text, p_tenant_type text, p_business text, p_subdomain text
) returns json language plpgsql security definer set search_path = public as $$
declare uid uuid; clean text; existing record; aid uuid;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  if coalesce(p_tenant_type,'') not in ('funeral_home','church') then p_tenant_type := 'funeral_home'; end if;

  select id into uid from public.profiles where lower(email) = lower(coalesce(p_owner_email,'')) limit 1;
  if uid is null then return json_build_object('error','no_such_user'); end if;

  select id, tenant_type, business_name into existing
    from public.concierge_accounts where owner_user_id = uid limit 1;
  if existing.id is not null and existing.tenant_type is distinct from p_tenant_type then
    return json_build_object('error','owner_has_other_account',
      'existing_type', existing.tenant_type, 'existing_business', existing.business_name);
  end if;

  clean := nullif(regexp_replace(lower(coalesce(p_subdomain,'')), '[^a-z0-9-]', '', 'g'), '');
  if clean is not null and length(clean) < 3 then return json_build_object('error','subdomain_too_short'); end if;
  if clean is not null and exists (
       select 1 from public.concierge_accounts where lower(subdomain) = clean and owner_user_id <> uid) then
    return json_build_object('error','subdomain_taken');
  end if;

  perform public.provision_concierge_account(uid, 'professional', p_business, clean, null, p_tenant_type);

  update public.concierge_accounts
     set tenant_type   = p_tenant_type,
         estate_limit  = 1000000000,
         business_name = coalesce(nullif(p_business,''), business_name),
         subdomain     = coalesce(clean, subdomain),
         updated_at    = now()
   where owner_user_id = uid;

  select id into aid from public.concierge_accounts where owner_user_id = uid limit 1;
  return json_build_object('ok', true, 'account_id', aid);
end $$;
grant execute on function public.admin_provision_partner(text,text,text,text) to authenticated;

-- 2) core provisioning (Stripe/Paythen concierge signups)
create or replace function public.provision_concierge_account(p_owner uuid, p_tier text, p_business text, p_subdomain text, p_stripe_sub text, p_tenant_type text default 'concierge')
returns json language plpgsql security definer set search_path to 'public' as $function$
declare aid uuid; clean_sub text;
begin
  if p_owner is null then return json_build_object('error','no_owner'); end if;
  if p_tier not in ('starter','professional','enterprise','agency') then p_tier := 'starter'; end if;

  select id into aid from public.concierge_accounts where owner_user_id = p_owner limit 1;

  clean_sub := nullif(regexp_replace(lower(coalesce(p_subdomain,'')), '[^a-z0-9-]', '', 'g'), '');
  if clean_sub is not null and exists
     (select 1 from public.concierge_accounts where lower(subdomain)=clean_sub and (aid is null or id<>aid)) then
    clean_sub := clean_sub || '-' || substr(md5(random()::text),1,4);
  end if;

  if aid is null then
    insert into public.concierge_accounts(owner_user_id, tenant_type, business_name, tier, status,
        estate_limit, subdomain, stripe_subscription_id)
      values (p_owner, coalesce(p_tenant_type,'concierge'), coalesce(nullif(p_business,''),'My Practice'),
        p_tier, 'active', public.default_estate_limit(p_tier), clean_sub, p_stripe_sub)
      returning id into aid;
    insert into public.tenant_branding(account_id) values (aid) on conflict do nothing;
  else
    update public.concierge_accounts
      set tier = p_tier, status = 'active',
          estate_limit = public.default_estate_limit(p_tier),
          business_name = coalesce(nullif(p_business,''), business_name),
          subdomain = coalesce(subdomain, clean_sub),
          stripe_subscription_id = coalesce(p_stripe_sub, stripe_subscription_id),
          updated_at = now()
    where id = aid;
  end if;
  return json_build_object('ok', true, 'account_id', aid);
end $function$;

-- 3) owner self-serve subdomain
create or replace function public.owner_set_subdomain(p_sub text)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare aid uuid; clean text;
begin
  select id into aid from public.concierge_accounts where owner_user_id = auth.uid() limit 1;
  if aid is null then return json_build_object('error','no_account'); end if;
  clean := regexp_replace(lower(coalesce(p_sub,'')), '[^a-z0-9-]', '', 'g');
  if length(clean) < 3 then return json_build_object('error','too_short'); end if;
  if exists (select 1 from public.concierge_accounts where lower(subdomain)=clean and id<>aid) then
    return json_build_object('error','taken'); end if;
  update public.concierge_accounts set subdomain = clean, updated_at = now() where id = aid;
  return json_build_object('ok', true, 'subdomain', clean);
end $function$;

-- 4) admin-set custom domain
create or replace function public.admin_set_custom_domain(target uuid, domain text)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare clean text;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  clean := nullif(regexp_replace(lower(coalesce(domain,'')), '[^a-z0-9.-]', '', 'g'), '');
  if clean is not null and exists (select 1 from public.concierge_accounts where lower(custom_domain)=clean and id<>target) then
    return json_build_object('error','taken'); end if;
  update public.concierge_accounts set custom_domain = clean, updated_at = now() where id = target;
  return json_build_object('ok', true, 'custom_domain', clean);
end $function$;
