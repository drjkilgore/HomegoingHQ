-- HomegoingHQ — Migration v28: co-brand partner applications (funeral homes & churches)
-- A public apply form (partners-apply.html) inserts a 'pending' row here. Admins
-- review it in the White-label section and Approve (which calls the existing
-- admin_provision_partner) or Decline. Mirrors provider_applications' public-insert
-- + admin-read pattern. Idempotent.

create extension if not exists pgcrypto;

create table if not exists public.partner_applications (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  status              text not null default 'pending' check (status in ('pending','approved','declined')),
  tenant_type         text not null default 'funeral_home' check (tenant_type in ('funeral_home','church')),
  business_name       text not null,
  owner_email         text not null,
  contact_name        text,
  phone               text,
  desired_subdomain   text,
  website             text,
  message             text,
  admin_notes         text,
  reviewed_by         uuid references auth.users(id),
  reviewed_at         timestamptz,
  provisioned_account uuid
);

alter table public.partner_applications enable row level security;

-- Table privileges (RLS still governs which rows each role can touch).
grant insert on public.partner_applications to anon, authenticated;
grant select, update, delete on public.partner_applications to authenticated;

-- Anyone may submit — but only a clean 'pending' row (nobody can self-approve).
drop policy if exists pa_public_insert on public.partner_applications;
create policy pa_public_insert on public.partner_applications
  for insert to anon, authenticated
  with check (status = 'pending' and reviewed_by is null and reviewed_at is null and provisioned_account is null);

-- Admins can read and manage everything.
drop policy if exists pa_admin_all on public.partner_applications;
create policy pa_admin_all on public.partner_applications
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Approve → provision. Reuses admin_provision_partner, which requires the owner to
-- already have a HomegoingHQ account; if they don't, we surface 'no_such_user' so
-- the admin can have them sign up (or send the apply link) and retry.
create or replace function public.admin_approve_partner_application(p_id uuid, p_subdomain text default null)
returns json language plpgsql security definer set search_path = public as $$
declare app public.partner_applications; sub text; res json;
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  select * into app from public.partner_applications where id = p_id;
  if app.id is null then return json_build_object('error','not_found'); end if;
  if app.status = 'approved' then return json_build_object('error','already_approved'); end if;

  sub := nullif(coalesce(p_subdomain, app.desired_subdomain), '');
  res := public.admin_provision_partner(app.owner_email, app.tenant_type, app.business_name, sub);
  if (res->>'error') is not null then
    return res;  -- e.g. no_such_user, subdomain_taken — admin fixes and retries
  end if;

  update public.partner_applications
     set status='approved', reviewed_by=auth.uid(), reviewed_at=now(),
         provisioned_account = nullif(res->>'account_id','')::uuid
   where id = p_id;
  return res;
end $$;

create or replace function public.admin_decline_partner_application(p_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return json_build_object('error','forbidden'); end if;
  update public.partner_applications
     set status='declined', reviewed_by=auth.uid(), reviewed_at=now(),
         admin_notes = coalesce(nullif(p_reason,''), admin_notes)
   where id = p_id and status <> 'approved';
  return json_build_object('ok', true);
end $$;

grant execute on function public.admin_approve_partner_application(uuid,text) to authenticated;
grant execute on function public.admin_decline_partner_application(uuid,text) to authenticated;

-- Verify (optional):
-- insert into public.partner_applications (tenant_type,business_name,owner_email,contact_name)
--   values ('funeral_home','Grace Funeral Home','director@example.com','Pat Rivera');
-- select public.admin_approve_partner_application('<id>','grace-funeral');
