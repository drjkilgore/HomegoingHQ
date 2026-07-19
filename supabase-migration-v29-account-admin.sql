-- HomegoingHQ — Migration v29: admin edits a white-label business name, and
-- deletes a white-label account (account only). Idempotent.

-- Rename an existing white-label account's business name.
create or replace function public.admin_set_account_business(target uuid, new_name text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return false; end if;
  if coalesce(trim(new_name),'') = '' then return false; end if;
  update public.concierge_accounts set business_name = trim(new_name), updated_at = now() where id = target;
  return found;
end $$;
grant execute on function public.admin_set_account_business(uuid,text) to authenticated;

-- Delete a white-label ACCOUNT ONLY. tenant_branding is removed automatically
-- (FK on delete cascade). The owner's login (profiles/auth) and any families or
-- estates they created are left intact — estates have no FK to the account, so
-- they simply lose the co-brand attribution.
create or replace function public.admin_delete_partner_account(p_account_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare biz text;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  select business_name into biz from public.concierge_accounts where id = p_account_id;
  if biz is null then return json_build_object('error','not_found'); end if;
  delete from public.concierge_accounts where id = p_account_id;  -- tenant_branding cascades
  return json_build_object('ok', true, 'business', biz);
end $$;
grant execute on function public.admin_delete_partner_account(uuid) to authenticated;
