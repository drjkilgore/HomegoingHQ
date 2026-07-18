-- Cookie consent event log for HomegoingHQ
create table if not exists public.cookie_consents (
  id              uuid primary key default gen_random_uuid(),
  consent_id      text,                      -- anonymous device id (first-party cookie hhq_cc_id)
  account_id      text,                      -- optional, if a user is signed in
  choice          text,                      -- accept_all | reject_non_essential | custom
  functional      boolean not null default false,
  analytics       boolean not null default false,
  advertising     boolean not null default false,
  policy_version  text,                      -- e.g. 2026-07-18; enables re-prompt on change
  gpc             boolean not null default false,
  user_agent      text,
  ip_address      text,
  created_at      timestamptz not null default now()
);

create index if not exists cookie_consents_consent_id_idx on public.cookie_consents (consent_id);
create index if not exists cookie_consents_account_id_idx on public.cookie_consents (account_id);
create index if not exists cookie_consents_created_at_idx on public.cookie_consents (created_at desc);

-- RLS on: only the service role (used by the Netlify function) may write/read.
-- Anonymous/browser clients get no direct access; all logging goes through log-consent.js.
alter table public.cookie_consents enable row level security;
-- (No permissive policies for anon/authenticated: service_role bypasses RLS.)
