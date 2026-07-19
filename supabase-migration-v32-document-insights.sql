-- HomegoingHQ — Migration v32: cache for "the Guide reads your document" insights.
-- One row per document; written by the analyze-document function (service role),
-- readable by estate members. Deleting the document removes its insight (cascade).

create table if not exists public.document_insights (
  document_id uuid primary key references public.documents(id) on delete cascade,
  estate_id   uuid not null references public.estates(id) on delete cascade,
  insight     jsonb not null,
  created_at  timestamptz not null default now()
);
alter table public.document_insights enable row level security;

grant select, insert, delete on public.document_insights to authenticated;

drop policy if exists di_members_read on public.document_insights;
create policy di_members_read on public.document_insights
  for select using (public.is_estate_member(estate_id));

drop policy if exists di_members_write on public.document_insights;
create policy di_members_write on public.document_insights
  for insert with check (public.is_estate_member(estate_id));

drop policy if exists di_members_delete on public.document_insights;
create policy di_members_delete on public.document_insights
  for delete using (public.is_estate_member(estate_id));
