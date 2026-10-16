# Riddlebound backend (API)
A Next.js 16 API-only app. The public site stays static on GitHub Pages (`../site`); this app adds accounts, entitlements, secure puzzle unlocks and Stripe sync. **Not deployed yet:** it needs a Supabase project and a host (Vercel), both the owner's decision.

## Endpoints
| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/api/books/unlock` | `Authorization: Bearer <Supabase access token>` | Body `{ bookId, assetId, submittedAnswer, userId? }`. Returns `{ ok, unlocked, firstTime, contentUrl, expiresInSeconds }` |
| POST | `/api/webhooks/stripe` | Stripe signature | Grants, renews and revokes memberships and single-book purchases |

**Unlock answers**
| Status | Meaning |
|---|---|
| 401 | Not signed in |
| 403 | `userId` in the body isn't the signed-in user, or no membership or purchase for this book |
| 400 | Bad input, or `incorrect` (wrong code) |
| 404 | Unknown puzzle |
| 429 | More than 5 submissions a minute per IP or per user; plain sentence and `Retry-After` |
| 500 | Server error with a reference id; never leaks internals |
| 503 | Not configured |

## Security model
- **Identity:** taken from the verified Supabase token. A `userId` in the body is only accepted if it matches.
- **Answers are never stored or compared as text.**
  - Stored as `HMAC-SHA256(RIDDLEBOUND_ANSWER_PEPPER, "book:asset:normalized")`.
  - Compared in constant time.
  - Normalized: accents removed, lowercase, only `a-z0-9` kept. So "Write it up" = "WRITE-IT-UP".
  - `book_assets` has RLS on and no client access.
- **Brute force:** 5 submissions a minute per IP and per user, checked before any database work. Shared counters run on Vercel KV / Upstash when configured. If the store is down, counting falls back to this server instance, never to "unlimited".
- **Progress can't be forged:** readers may save their chapter and snapshot but cannot write `unlocked_codes` (column-level grants). Only `rb_record_unlock`, called after a correct answer, adds codes. It also writes an append-only `unlock_history`.
- **Content:** files sit in the private Storage bucket `riddlebound-assets`. Each unlock returns a signed link valid for `UNLOCK_URL_TTL_SECONDS` (default 300).
- **Stripe:**
  - The signature is verified on the raw body.
  - Each event id is processed once (`stripe_events` table).
  - Out-of-order events are ignored per member (`stripe_event_created`).
  - Only objects with `metadata.product = "riddlebound"` are acted on, because the Stripe account also bills other products.
  - A subscription that arrives before its checkout links the customer returns 500, so Stripe retries until the link exists.

## Stripe checkout requirements
When creating Riddlebound checkouts (not built yet), set:
- `client_reference_id` = the member's Supabase user id;
- `metadata.product = "riddlebound"`, and also `subscription_data.metadata.product = "riddlebound"` for memberships;
- for a single book: `mode = "payment"`, `metadata.purchase_type = "single_book"`, `metadata.book_id = "<book-id>"`.

Webhook events to enable:
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

## Setup
1. **Database:** run `supabase/migrations/0001_members_unlocks_billing.sql` in the Supabase SQL Editor. It was tested on Postgres 16, with 31 checks on RLS, grants, idempotency and ordering.
2. **Secrets:** set the environment variables in `.env.example` on the host.
3. **Add each puzzle:**
   - `RIDDLEBOUND_ANSWER_PEPPER=... npm run hash-answer -- <book-id> <asset-id> "<answer>"`;
   - insert the row into `book_assets`, with `encrypted_content_url` = `riddlebound-assets/<path>`;
   - upload the file to that private bucket.
4. **Checks:** `npm test` (24 tests), `npm run typecheck`, `npm run build`.

## Redeemable codes (`POST /api/codes/redeem`)

For codes a viewer hears or sees outside a book, such as the code read at the end of a video.
Body `{ "code": "GHOST-ZERO" }`, header `Authorization: Bearer <Supabase access token>`.

| Situation | Answer |
|---|---|
| Logged out | 401 `unauthenticated` + `joinUrl` |
| 6th try in a minute (per IP or per user) | 429 + `Retry-After` |
| Unknown or switched-off code | 404 `unknown_code` |
| Right code, no active membership or purchase of that book | 403 `no_access`, `requiresSubscription: true`, `joinUrl` |
| Right code, member | 200 + a signed link to the file (5 minutes), unlock recorded once |

Codes are stored only as keyed hashes (`redeem_codes`, migration 0002), and each one must point at a
`book_assets` row, so a code can't go live before its file is uploaded. To add one:

1. Upload the file to the private `riddlebound-assets` bucket and add its `book_assets` row.
2. `RIDDLEBOUND_ANSWER_PEPPER=... node scripts/add-code.mjs GHOST-ZERO ghost-freight dossier-001`
3. Paste the printed SQL into Supabase → SQL Editor.

`RIDDLEBOUND_JOIN_URL` (default `https://riddlebound.app/join/`) is the link sent with 401 and 403 answers.
