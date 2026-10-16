-- =====================================================================
-- Riddlebound — 0002: redeemable codes (e.g. codes read out at the end of a video)
--
-- HOW TO RUN: Supabase → SQL Editor → New query → paste → Run, once, after 0001.
--
-- A viewer types only a code ("GHOST-ZERO"). The server hashes it with the same secret
-- pepper as puzzle answers (HMAC-SHA256 of "code:" + normalized code) and looks the hash up
-- here. Codes are stored only as hashes and are readable by the server only.
--
-- Every code must point at a book_assets row (foreign key): a code cannot go live before its
-- content is uploaded, so nobody is ever asked to pay for a dossier that doesn't exist.
-- =====================================================================

create table public.redeem_codes (
  code_hash   text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  book_id     text not null,
  asset_id    text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  foreign key (book_id, asset_id) references public.book_assets (book_id, asset_id) on delete cascade
);
create index redeem_codes_asset_idx on public.redeem_codes (book_id, asset_id);

alter table public.redeem_codes enable row level security;
revoke all on public.redeem_codes from public, anon, authenticated;
grant all on public.redeem_codes to service_role;

-- Appends an unlocked code (stored as its asset id) to the reader's book_progress.unlocked_codes,
-- atomically and without rewriting earlier entries, and records it in the permanent unlock_history.
-- Same behavior as rb_record_unlock (0001), which it calls; returns true the first time only.
create or replace function public.append_unlocked_code_to_progress(p_user_id uuid, p_book_id text, p_code text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$ select public.rb_record_unlock(p_user_id, p_book_id, p_code) $$;

revoke execute on function public.append_unlocked_code_to_progress(uuid, text, text) from public, anon, authenticated;
grant execute on function public.append_unlocked_code_to_progress(uuid, text, text) to service_role;
