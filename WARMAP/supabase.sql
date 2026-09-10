-- SICILY RP MAP — Supabase setup
-- 1) Create a Supabase project.
-- 2) In Authentication > Providers, enable Email.
-- 3) Run this entire script in SQL Editor.
-- 4) Create your GM user in Authentication > Users.
-- 5) Put Project URL + anon public key into index.html.

create table if not exists public.sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner text not null check (owner in ('allies','axis','disputed')),
  notes text default '',
  geometry jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.objects (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  name text not null,
  notes text default '',
  lat double precision not null,
  lng double precision not null,
  created_at timestamptz not null default now()
);

alter table public.sectors enable row level security;
alter table public.objects enable row level security;

drop policy if exists "Public can read sectors" on public.sectors;
drop policy if exists "Authenticated can edit sectors" on public.sectors;
drop policy if exists "Public can read objects" on public.objects;
drop policy if exists "Authenticated can edit objects" on public.objects;

create policy "Public can read sectors"
on public.sectors for select
to anon, authenticated
using (true);

create policy "Authenticated can edit sectors"
on public.sectors for all
to authenticated
using (true)
with check (true);

create policy "Public can read objects"
on public.objects for select
to anon, authenticated
using (true);

create policy "Authenticated can edit objects"
on public.objects for all
to authenticated
using (true)
with check (true);

-- Realtime publication:
alter publication supabase_realtime add table public.sectors;
alter publication supabase_realtime add table public.objects;
