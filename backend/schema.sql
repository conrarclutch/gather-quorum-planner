-- Priests youth activity planner. Apply in the Supabase SQL editor before deploying.
create extension if not exists pgcrypto;

create table if not exists public.qp_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  invite_code_hash text not null unique,
  owner_code_hash text not null,
  created_at timestamptz not null default now(),
  check (invite_code_hash <> owner_code_hash)
);

create table if not exists public.qp_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.qp_groups(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 60),
  role text not null default 'member' check (role in ('member','owner')),
  created_at timestamptz not null default now(),
  unique (id, group_id)
);

create table if not exists public.qp_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.qp_members(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.qp_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.qp_groups(id) on delete cascade,
  original_title text not null,
  source_url text not null,
  source_tab text not null,
  source_row integer not null,
  source_id text not null,
  source_date text not null,
  original_date_serial integer,
  date_caveat text not null default '',
  event_date date not null,
  year_confidence text not null,
  status text not null default 'planned',
  scope text not null default '',
  details text not null default '',
  location text,
  meeting_point text,
  departure_time text,
  start_time text,
  end_time text,
  return_time text,
  leader text,
  notes text,
  confirmed boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (group_id, source_id, source_tab, source_row)
);

create table if not exists public.qp_tasks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.qp_groups(id) on delete cascade,
  event_id uuid not null references public.qp_events(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  quantity integer not null default 1 check (quantity between 1 and 100),
  category text not null default 'general' check (char_length(category) between 1 and 40),
  suggested boolean not null default false,
  claimed_by uuid references public.qp_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, group_id),
  unique (event_id, title)
);

create table if not exists public.qp_rsvps (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.qp_groups(id) on delete cascade,
  event_id uuid not null references public.qp_events(id) on delete cascade,
  member_id uuid not null references public.qp_members(id) on delete cascade,
  status text not null check (status in ('going','maybe','declined')),
  count integer not null default 1 check (count between 1 and 20),
  ride_needed integer not null default 0 check (ride_needed between 0 and count),
  seats_offered integer not null default 0 check (seats_offered between 0 and 12),
  notes text not null default '' check (char_length(notes) <= 500),
  updated_at timestamptz not null default now(),
  unique (event_id, member_id)
);

create index if not exists qp_members_group_idx on public.qp_members(group_id);
create index if not exists qp_sessions_member_expiry_idx on public.qp_sessions(member_id, expires_at);
create index if not exists qp_events_group_date_idx on public.qp_events(group_id, event_date);
create index if not exists qp_tasks_event_idx on public.qp_tasks(event_id);
create index if not exists qp_rsvps_event_idx on public.qp_rsvps(event_id);

create or replace function public.qp_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function public.qp_touch_updated_at() from public, anon, authenticated;
drop trigger if exists qp_events_touch_updated_at on public.qp_events;
create trigger qp_events_touch_updated_at before update on public.qp_events
for each row execute function public.qp_touch_updated_at();
drop trigger if exists qp_tasks_touch_updated_at on public.qp_tasks;
create trigger qp_tasks_touch_updated_at before update on public.qp_tasks
for each row execute function public.qp_touch_updated_at();
drop trigger if exists qp_rsvps_touch_updated_at on public.qp_rsvps;
create trigger qp_rsvps_touch_updated_at before update on public.qp_rsvps
for each row execute function public.qp_touch_updated_at();

-- The planner uses a single Edge Function with a service-role client. The browser
-- has no direct table access, including to the source schedule.
alter table public.qp_groups enable row level security;
alter table public.qp_members enable row level security;
alter table public.qp_sessions enable row level security;
alter table public.qp_events enable row level security;
alter table public.qp_tasks enable row level security;
alter table public.qp_rsvps enable row level security;
revoke all on public.qp_groups, public.qp_members, public.qp_sessions, public.qp_events, public.qp_tasks, public.qp_rsvps from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.qp_groups, public.qp_members, public.qp_sessions, public.qp_events, public.qp_tasks, public.qp_rsvps to service_role;

-- Atomic claiming: only an unclaimed task or the caller's own claim can change.
create or replace function public.qp_claim_task(p_task_id uuid, p_group_id uuid, p_member_id uuid, p_claim boolean)
returns setof public.qp_tasks
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
    update public.qp_tasks t
       set claimed_by = case when p_claim then p_member_id else null end,
           updated_at = now()
     where t.id = p_task_id
       and t.group_id = p_group_id
       and (t.claimed_by is null or t.claimed_by = p_member_id)
    returning t.*;
end;
$$;
revoke all on function public.qp_claim_task(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.qp_claim_task(uuid, uuid, uuid, boolean) to service_role;
