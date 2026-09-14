-- Orbit public multi-user database.
-- Run this entire file once in Supabase Dashboard → SQL Editor.

create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  college_name text not null default '',
  college_domain text,
  department text not null default '',
  study_year text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.student_spaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('class','department','society','hostel','club')),
  created_at timestamptz not null default now(),
  unique(user_id, name)
);

create table public.colleges (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  website_url text,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

-- Admin-owned official sources. Do not put student passwords in this table.
create table public.college_sources (
  id uuid primary key default gen_random_uuid(),
  college_id uuid not null references public.colleges(id) on delete cascade,
  source_type text not null check (source_type in ('rss','api','telegram','whatsapp_business')),
  display_name text not null,
  source_url text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.updates (
  id uuid primary key default gen_random_uuid(),
  college_id uuid references public.colleges(id) on delete cascade,
  source_type text not null check (source_type in ('teacher','email','telegram','portal','whatsapp_business','society','class')),
  source_name text not null,
  title text not null,
  body text not null default '',
  priority integer not null default 50 check (priority between 0 and 100),
  deadline_at timestamptz,
  published_at timestamptz not null default now(),
  external_id text unique
);

create table public.saved_updates (
  user_id uuid not null references auth.users(id) on delete cascade,
  update_id uuid not null references public.updates(id) on delete cascade,
  is_read boolean not null default false,
  saved_at timestamptz not null default now(),
  primary key(user_id, update_id)
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  update_id uuid not null references public.updates(id) on delete cascade,
  remind_at timestamptz not null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, update_id)
);

alter table public.profiles enable row level security;
alter table public.student_spaces enable row level security;
alter table public.colleges enable row level security;
alter table public.college_sources enable row level security;
alter table public.updates enable row level security;
alter table public.saved_updates enable row level security;
alter table public.reminders enable row level security;

-- Students can only access their own profile, memberships, saved items and reminders.
create policy "own profile" on public.profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "own spaces" on public.student_spaces for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own saved updates" on public.saved_updates for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own reminders" on public.reminders for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Authenticated students may read verified colleges and published official updates.
create policy "read verified colleges" on public.colleges for select to authenticated using (verified = true);
create policy "read enabled sources" on public.college_sources for select to authenticated using (enabled = true);
create policy "read official updates" on public.updates for select to authenticated using (true);

-- Populate a profile automatically at each sign-up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email, 'Student'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create index updates_deadline_idx on public.updates(deadline_at);
create index updates_college_priority_idx on public.updates(college_id, priority desc, published_at desc);
