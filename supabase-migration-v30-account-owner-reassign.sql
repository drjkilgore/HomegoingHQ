-- HomegoingHQ — Migration v30: reassign a white-label account to a different owner,
-- and move/revoke a concierge's linked families. Idempotent.

-- ── Move an account to a different existing HomegoingHQ login ────────────────
create or replace function public.admin_set_account_owner(target uuid, new_owner_email text)
returns json language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  select id into uid from public.profiles where lower(email) = lower(coalesce(new_owner_email,'')) limit 1;
  if uid is null then return json_build_object('error','no_such_user'); end if;
  if exists (select 1 from public.concierge_accounts where owner_user_id = uid and id <> target) then
    return json_build_object('error','owner_has_account');
  end if;
  update public.concierge_accounts set owner_user_id = uid, updated_at = now() where id = target;
  if not found then return json_build_object('error','not_found'); end if;
  return json_build_object('ok', true, 'new_owner', lower(new_owner_email));
end $$;
grant execute on function public.admin_set_account_owner(uuid,text) to authenticated;

-- ── Owner email for the admin UI (RLS hides other users' profiles) ──────────
create or replace function public.admin_account_owner_email(p_account uuid)
returns text language plpgsql security definer set search_path = public as $$
declare em text;
begin
  if not public.is_admin() then return null; end if;
  select p.email into em from public.profiles p
    join public.concierge_accounts c on c.owner_user_id = p.id
   where c.id = p_account;
  return em;
end $$;
grant execute on function public.admin_account_owner_email(uuid) to authenticated;

-- ── Count a concierge's active client families ──────────────────────────────
create or replace function public.admin_concierge_family_count(p_account uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare owner uuid; n integer;
begin
  if not public.is_admin() then return 0; end if;
  select owner_user_id into owner from public.concierge_accounts where id = p_account;
  if owner is null then return 0; end if;
  select count(*) into n from public.estate_concierge_links where concierge_id = owner and status = 'active';
  return coalesce(n,0);
end $$;
grant execute on function public.admin_concierge_family_count(uuid) to authenticated;

-- ── Reassign a concierge's families to another concierge (RE-INVITE) ────────
-- Each active/invited link is re-addressed to the new concierge as a PENDING
-- invite: concierge_id cleared, status 'invited'. It only becomes active when
-- the new concierge accepts — preserving the family-consent model. If the
-- destination is already linked to that estate, the old link is simply revoked.
create or replace function public.admin_reassign_concierge_families(p_from_account uuid, p_to_account uuid)
returns json language plpgsql security definer set search_path = public as $$
declare from_user uuid; to_user uuid; to_email text; moved int := 0; lnk record;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  if p_from_account = p_to_account then return json_build_object('error','same_account'); end if;
  select owner_user_id into from_user from public.concierge_accounts where id = p_from_account;
  select c.owner_user_id, p.email into to_user, to_email
    from public.concierge_accounts c join public.profiles p on p.id = c.owner_user_id
   where c.id = p_to_account;
  if from_user is null or to_user is null or to_email is null then return json_build_object('error','not_found'); end if;

  for lnk in
    select id, estate_id from public.estate_concierge_links
     where concierge_id = from_user and status in ('active','invited')
  loop
    if exists (select 1 from public.estate_concierge_links
                where estate_id = lnk.estate_id and lower(email) = lower(to_email)) then
      update public.estate_concierge_links set status = 'revoked', responded_at = now() where id = lnk.id;
    else
      update public.estate_concierge_links
         set email = lower(to_email), concierge_id = null, status = 'invited', responded_at = null
       where id = lnk.id;
      moved := moved + 1;
    end if;
  end loop;
  return json_build_object('ok', true, 'moved', moved);
end $$;
grant execute on function public.admin_reassign_concierge_families(uuid,uuid) to authenticated;

-- ── Revoke all of a concierge's family links (sever access) ─────────────────
create or replace function public.admin_revoke_concierge_links(p_account uuid)
returns json language plpgsql security definer set search_path = public as $$
declare owner uuid; n int;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  select owner_user_id into owner from public.concierge_accounts where id = p_account;
  if owner is null then return json_build_object('error','not_found'); end if;
  with upd as (
    update public.estate_concierge_links set status = 'revoked', responded_at = now()
     where concierge_id = owner and status in ('active','invited') returning 1
  ) select count(*) into n from upd;
  return json_build_object('ok', true, 'revoked', coalesce(n,0));
end $$;
grant execute on function public.admin_revoke_concierge_links(uuid) to authenticated;
