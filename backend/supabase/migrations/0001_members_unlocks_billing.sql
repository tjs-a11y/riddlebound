-- =====================================================================
-- Riddlebound — members, entitlements, reading progress, secure puzzle
-- assets and Stripe sync.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. One transaction: all or nothing.
--
-- Based on the owner's draft schema, with four security fixes:
--  1. book_assets now has row-level security and NO client access. In the
--     draft it had none, so Supabase's public API would hand every visitor
--     the answer hashes, and short codes can be cracked offline in seconds.
--  2. Readers can no longer write unlocked_codes themselves. The draft's
--     "FOR ALL" policy let any signed-in user add every code to their own
--     progress. Unlocks are now recorded only by the server
--     (rb_record_unlock), after the answer is checked.
--  3. Answer hashes are keyed with a server-only secret (HMAC-SHA256 with
--     RIDDLEBOUND_ANSWER_PEPPER), so even a leaked hash can't be brute-forced
--     without the secret.
--  4. Entitlements get unique keys and a Stripe event timestamp, so webhook
--     retries and out-of-order deliveries can't create duplicates or
--     resurrect a cancelled membership.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Profiles (one per Supabase Auth user)
-- ---------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  full_name          text check (full_name is null or length(full_name) <= 200),
  stripe_customer_id text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  updated_at         timestamptz not null default now()
);

-- Every new sign-up gets a profile row automatically.
create or replace function public.rb_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger rb_on_auth_user_created
  after insert on auth.users
  for each row execute function public.rb_handle_new_user();

-- ---------------------------------------------------------------------
-- Entitlements: what a member may read
-- ---------------------------------------------------------------------
create table public.entitlements (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,
  type                   text not null check (type in ('membership_active', 'single_book_purchase')),
  book_id                text check (book_id is null or book_id ~ '^[a-z0-9-]{1,64}$'),
  created_at             timestamptz not null default now(),
  expires_at             timestamptz,                 -- null = lifetime (single purchase)
  stripe_subscription_id text,
  stripe_checkout_id     text unique,
  stripe_event_created   bigint not null default 0,   -- newest Stripe event applied to this row
  updated_at             timestamptz not null default now(),
  -- A membership covers every book; a single purchase names exactly one.
  check ((type = 'membership_active' and book_id is null) or (type = 'single_book_purchase' and book_id is not null))
);
-- One membership row per member (renewals update it), one purchase per book.
create unique index entitlements_one_membership on public.entitlements (user_id) where type = 'membership_active';
create unique index entitlements_one_book on public.entitlements (user_id, book_id) where type = 'single_book_purchase';

-- ---------------------------------------------------------------------
-- Reading progress (cross-device sync)
-- ---------------------------------------------------------------------
create table public.book_progress (
  user_id                uuid not null references public.profiles (id) on delete cascade,
  book_id                text not null check (book_id ~ '^[a-z0-9-]{1,64}$'),
  current_chapter_id     text not null check (length(current_chapter_id) between 1 and 100),
  unlocked_codes         text[] not null default '{}'::text[],   -- asset ids, written only by rb_record_unlock
  local_storage_snapshot jsonb not null default '{}'::jsonb check (pg_column_size(local_storage_snapshot) <= 65536),
  updated_at             timestamptz not null default now(),
  primary key (user_id, book_id)
);

-- Append-only history of every unlock ("profile history").
create table public.unlock_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  book_id     text not null,
  asset_id    text not null,
  unlocked_at timestamptz not null default now(),
  unique (user_id, book_id, asset_id)
);

-- ---------------------------------------------------------------------
-- Secure puzzle assets (server-only)
-- ---------------------------------------------------------------------
create table public.book_assets (
  book_id               text not null check (book_id ~ '^[a-z0-9-]{1,64}$'),
  asset_id              text not null check (asset_id ~ '^[a-z0-9-]{1,64}$'),
  hashed_answer         text not null check (hashed_answer ~ '^[0-9a-f]{64}$'), -- HMAC-SHA256(pepper, book:asset:normalized), hex
  encrypted_content_url text not null,  -- private Storage object, "bucket/path/to/file"; served only via short-lived signed URLs
  primary key (book_id, asset_id)
);

-- Stripe webhook idempotency: one row per event id.
create table public.stripe_events (
  id           text primary key check (id ~ '^evt_[A-Za-z0-9]+$'),
  type         text not null,
  created      bigint not null,
  status       text not null default 'processing' check (status in ('processing', 'processed', 'failed', 'ignored')),
  attempts     integer not null default 1,
  error        text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.entitlements   enable row level security;
alter table public.book_progress  enable row level security;
alter table public.unlock_history enable row level security;
alter table public.book_assets    enable row level security;   -- no policies: server only
alter table public.stripe_events  enable row level security;   -- no policies: server only

create policy "Read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "Update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "Read own entitlements" on public.entitlements for select to authenticated using (user_id = auth.uid());
create policy "Read own progress" on public.book_progress for select to authenticated using (user_id = auth.uid());
create policy "Start own progress" on public.book_progress for insert to authenticated with check (user_id = auth.uid());
create policy "Save own progress" on public.book_progress for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Read own unlock history" on public.unlock_history for select to authenticated using (user_id = auth.uid());

-- Column-level grants are what stop a reader from writing unlocked_codes or
-- stripe_customer_id: policies decide WHICH rows, grants decide WHICH columns.
revoke all on public.profiles, public.entitlements, public.book_progress, public.unlock_history,
              public.book_assets, public.stripe_events from public, anon, authenticated;
grant select on public.profiles, public.entitlements, public.book_progress, public.unlock_history to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant insert (user_id, book_id, current_chapter_id, local_storage_snapshot) on public.book_progress to authenticated;
grant update (current_chapter_id, local_storage_snapshot) on public.book_progress to authenticated;
grant all on public.profiles, public.entitlements, public.book_progress, public.unlock_history,
             public.book_assets, public.stripe_events to service_role;

-- unlock_history is append-only, even for the server.
create or replace function public.rb_prevent_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are permanent', tg_table_name;
end;
$$;
create trigger unlock_history_append_only before update or delete on public.unlock_history
  for each row execute function public.rb_prevent_change();

-- ---------------------------------------------------------------------
-- Server functions (service_role only)
-- ---------------------------------------------------------------------
-- May this user read this book right now?
create or replace function public.rb_has_book_access(p_user uuid, p_book text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and (e.type = 'membership_active' or (e.type = 'single_book_purchase' and e.book_id = p_book))
      and (e.expires_at is null or e.expires_at > now())
  )
$$;

-- Records a verified unlock: adds the asset to the reader's progress (once)
-- and to their permanent history. Returns true if this was a new unlock.
create or replace function public.rb_record_unlock(p_user uuid, p_book text, p_asset text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  added boolean;
begin
  insert into public.book_progress (user_id, book_id, current_chapter_id, unlocked_codes)
  values (p_user, p_book, 'start', array[p_asset])
  on conflict (user_id, book_id) do update
    set unlocked_codes = case
          when p_asset = any (public.book_progress.unlocked_codes) then public.book_progress.unlocked_codes
          else public.book_progress.unlocked_codes || p_asset
        end,
        updated_at = now();
  insert into public.unlock_history (user_id, book_id, asset_id)
  values (p_user, p_book, p_asset)
  on conflict (user_id, book_id, asset_id) do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

-- Stripe idempotency. Returns 'new' (process it), 'retry' (a previous attempt
-- failed or was interrupted: process again) or 'duplicate' (already done).
create or replace function public.rb_stripe_event_begin(p_id text, p_type text, p_created bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur text;
begin
  insert into public.stripe_events (id, type, created) values (p_id, p_type, p_created)
  on conflict (id) do nothing;
  if found then
    return 'new';
  end if;
  select status into cur from public.stripe_events where id = p_id for update;
  if cur in ('processed', 'ignored') then
    return 'duplicate';
  end if;
  update public.stripe_events set status = 'processing', attempts = attempts + 1, error = null where id = p_id;
  return 'retry';
end;
$$;

create or replace function public.rb_stripe_event_finish(p_id text, p_status text, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.stripe_events
     set status = p_status, error = left(p_error, 500),
         processed_at = case when p_status in ('processed', 'ignored') then now() else processed_at end
   where id = p_id
$$;

-- Links a Stripe customer to a member (from checkout.session.completed's
-- client_reference_id). A customer id can belong to only one member.
create or replace function public.rb_link_customer(p_user uuid, p_customer text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner uuid;
begin
  select id into owner from public.profiles where stripe_customer_id = p_customer;
  if owner is not null and owner <> p_user then
    return 'conflict';
  end if;
  update public.profiles set stripe_customer_id = p_customer, updated_at = now()
   where id = p_user and (stripe_customer_id is null or stripe_customer_id = p_customer);
  if not found then
    return case when exists (select 1 from public.profiles where id = p_user) then 'conflict' else 'no_user' end;
  end if;
  return 'linked';
end;
$$;

-- Applies a subscription's state to the member's single membership row.
-- p_expires_at: end of the paid period while active, now() when it ends.
-- Events older than the row's last applied event are ignored ('stale').
create or replace function public.rb_apply_membership(
  p_customer text, p_subscription text, p_expires_at timestamptz, p_event_created bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  member uuid;
  cur_ts bigint;
begin
  select id into member from public.profiles where stripe_customer_id = p_customer;
  if member is null then
    return 'no_user';
  end if;
  select stripe_event_created into cur_ts from public.entitlements
   where user_id = member and type = 'membership_active' for update;
  if cur_ts is not null and cur_ts > p_event_created then
    return 'stale';
  end if;
  insert into public.entitlements (user_id, type, expires_at, stripe_subscription_id, stripe_event_created)
  values (member, 'membership_active', p_expires_at, p_subscription, p_event_created)
  on conflict (user_id) where type = 'membership_active' do update
    set expires_at = excluded.expires_at,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_event_created = excluded.stripe_event_created,
        updated_at = now();
  return 'applied';
end;
$$;

-- Grants a lifetime single-book purchase. Idempotent per checkout session.
create or replace function public.rb_grant_book(p_customer text, p_book text, p_checkout text, p_event_created bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  member uuid;
begin
  select id into member from public.profiles where stripe_customer_id = p_customer;
  if member is null then
    return 'no_user';
  end if;
  insert into public.entitlements (user_id, type, book_id, expires_at, stripe_checkout_id, stripe_event_created)
  values (member, 'single_book_purchase', p_book, null, p_checkout, p_event_created)
  on conflict do nothing;
  return 'granted';
end;
$$;

revoke execute on function public.rb_has_book_access(uuid, text), public.rb_record_unlock(uuid, text, text),
  public.rb_stripe_event_begin(text, text, bigint), public.rb_stripe_event_finish(text, text, text),
  public.rb_link_customer(uuid, text), public.rb_apply_membership(text, text, timestamptz, bigint),
  public.rb_grant_book(text, text, text, bigint), public.rb_handle_new_user(), public.rb_prevent_change()
  from public, anon, authenticated;
grant execute on function public.rb_has_book_access(uuid, text), public.rb_record_unlock(uuid, text, text),
  public.rb_stripe_event_begin(text, text, bigint), public.rb_stripe_event_finish(text, text, text),
  public.rb_link_customer(uuid, text), public.rb_apply_membership(text, text, timestamptz, bigint),
  public.rb_grant_book(text, text, text, bigint)
  to service_role;

-- ---------------------------------------------------------------------
-- Private storage bucket for unlockable content (audio, bonus chapters)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('riddlebound-assets', 'riddlebound-assets', false)
on conflict (id) do update set public = false;

commit;
