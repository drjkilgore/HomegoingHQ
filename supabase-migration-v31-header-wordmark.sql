-- HomegoingHQ — Migration v31: white-label header & media controls.
--  • header_text (+ font / bold / italic / size): wordmark beside the logo.
--  • logo_size: how large the header logo renders (sm / md / lg / xl).
--  • intro_video_url: the partner's own intro video (YouTube / Vimeo / MP4).
-- Safe to re-run — drops any earlier admin_set_header_text overload first.

alter table public.tenant_branding add column if not exists header_text     text;
alter table public.tenant_branding add column if not exists header_font     text;
alter table public.tenant_branding add column if not exists header_bold     boolean not null default false;
alter table public.tenant_branding add column if not exists header_italic   boolean not null default false;
alter table public.tenant_branding add column if not exists header_size     text not null default 'md';
alter table public.tenant_branding add column if not exists logo_size       text not null default 'md';
alter table public.tenant_branding add column if not exists intro_video_url text;

drop function if exists public.admin_set_header_text(uuid,text,text,boolean,boolean,text);
drop function if exists public.admin_set_header_text(uuid,text,text,boolean,boolean,text,text);
drop function if exists public.admin_set_header_text(uuid,text,text,boolean,boolean,text,text,text);

-- Single JSON payload so the signature never changes as we add display fields.
create or replace function public.admin_set_branding_display(target uuid, p jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return false; end if;
  insert into public.tenant_branding(account_id, updated_at)
    values (target, now())
    on conflict (account_id) do nothing;
  update public.tenant_branding set
    header_text     = nullif(btrim(coalesce(p->>'header_text','')),''),
    header_font     = nullif(p->>'header_font',''),
    header_bold     = coalesce((p->>'header_bold')::boolean, false),
    header_italic   = coalesce((p->>'header_italic')::boolean, false),
    header_size     = coalesce(nullif(p->>'header_size',''),'md'),
    logo_size       = coalesce(nullif(p->>'logo_size',''),'md'),
    intro_video_url = nullif(btrim(coalesce(p->>'intro_video_url','')),''),
    updated_at      = now()
  where account_id = target;
  return found;
end $$;
grant execute on function public.admin_set_branding_display(uuid,jsonb) to authenticated;

create or replace function public.public_branding(host text)
returns json language plpgsql stable security definer set search_path = public as $$
declare a record; sub text;
begin
  host := lower(coalesce(host,''));
  sub  := split_part(host, '.', 1);
  select ca.id, ca.business_name, ca.tier, ca.tenant_type, ca.status,
         tb.logo_url, tb.favicon_url, tb.hero_url,
         tb.color_ink, tb.color_accent, tb.color_accent_deep,
         tb.contact_name, tb.contact_email, tb.contact_phone, tb.footer_note,
         tb.header_text, tb.header_font, tb.header_bold, tb.header_italic,
         tb.header_size, tb.logo_size, tb.intro_video_url
    into a
  from public.concierge_accounts ca
  left join public.tenant_branding tb on tb.account_id = ca.id
  where ca.status = 'active'
    and ( lower(ca.custom_domain) = host
          or (host like '%.homegoinghq.com' and lower(ca.subdomain) = sub) )
  limit 1;

  if a.id is null then
    return json_build_object('found', false);
  end if;

  return json_build_object(
    'found', true,
    'business_name', a.business_name,
    'tenant_type',   a.tenant_type,
    'homegoing_visible', (a.tier = 'starter'),
    'logo_url',    a.logo_url,
    'favicon_url', a.favicon_url,
    'hero_url',    a.hero_url,
    'color_ink',         coalesce(a.color_ink,'#26332E'),
    'color_accent',      coalesce(a.color_accent,'#8F6A24'),
    'color_accent_deep', coalesce(a.color_accent_deep,'#75561D'),
    'contact_name',  a.contact_name,
    'contact_email', a.contact_email,
    'contact_phone', a.contact_phone,
    'footer_note',   a.footer_note,
    'header_text',   a.header_text,
    'header_font',   a.header_font,
    'header_bold',   coalesce(a.header_bold,false),
    'header_italic', coalesce(a.header_italic,false),
    'header_size',   coalesce(a.header_size,'md'),
    'logo_size',     coalesce(a.logo_size,'md'),
    'intro_video_url', a.intro_video_url
  );
end $$;
