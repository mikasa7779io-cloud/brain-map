# Brain Map Supabase Sync

This setup keeps Brain Map isolated from the PaperReviewBoard `app_state` table.
Brain Map only reads and writes `public.brain_map_state`.

Run this SQL in the Supabase SQL editor for the same project if you want phone and desktop sync:

```sql
create table if not exists public.brain_map_state (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.brain_map_state enable row level security;

revoke all on table public.brain_map_state from anon, authenticated;
grant select, insert, update, delete on table public.brain_map_state to authenticated;

drop policy if exists "Users can read their own brain map state" on public.brain_map_state;
drop policy if exists "Users can insert their own brain map state" on public.brain_map_state;
drop policy if exists "Users can update their own brain map state" on public.brain_map_state;
drop policy if exists "Users can delete their own brain map state" on public.brain_map_state;

create policy "Users can read their own brain map state"
on public.brain_map_state for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert their own brain map state"
on public.brain_map_state for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own brain map state"
on public.brain_map_state for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own brain map state"
on public.brain_map_state for delete to authenticated
using ((select auth.uid()) = user_id);
```

Notes:

- Do not reuse or alter `public.app_state`; that table belongs to PaperReviewBoard.
- Brain Map stores one row per user. The row id is `${user_id}:main`.
- The app remains local-first. If Supabase is unavailable, local saving still works.
