create table if not exists public.vault_lessons (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 100),
  lesson jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  primary key (user_id, id),
  constraint vault_lessons_deletion_shape check (
    (deleted_at is null and lesson is not null)
    or (deleted_at is not null and lesson is null)
  )
);

alter table public.vault_lessons enable row level security;

drop policy if exists "Users can read their own vault lessons" on public.vault_lessons;
create policy "Users can read their own vault lessons"
  on public.vault_lessons for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own vault lessons" on public.vault_lessons;
create policy "Users can insert their own vault lessons"
  on public.vault_lessons for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own vault lessons" on public.vault_lessons;
create policy "Users can update their own vault lessons"
  on public.vault_lessons for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.vault_lessons to authenticated;
