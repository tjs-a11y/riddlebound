import { hashCode } from "./answers";
import { clientIp, jsonError, jsonOk, log, requestId } from "./http";
import { rateLimit } from "./ratelimit";

// POST /api/codes/redeem  { code }   Header: Authorization: Bearer <Supabase access token>
//
// For codes a viewer hears or sees outside a book (e.g. "GHOST-ZERO" at the end of a video).
//   1. Sign-in (401, with the join link). The user comes from the verified token only.
//   2. Input (400).
//   3. Rate limit: 5 tries per minute per IP and per user (429), before any database work.
//   4. Code lookup by keyed hash (404 if unknown or switched off).
//   5. Membership or purchase of the code's book (403, with the join link).
//   6. Record the unlock (append-only), then a short-lived signed link to the content.

export const REDEEMS_PER_MINUTE = 5;

export interface RedeemDeps {
  authenticate(request: Request): Promise<{ id: string } | null>;
  findCode(codeHash: string): Promise<{ book_id: string; asset_id: string; encrypted_content_url: string } | null>;
  hasAccess(userId: string, bookId: string): Promise<boolean>;
  recordUnlock(userId: string, bookId: string, assetId: string): Promise<boolean>;
  signedUrl(objectPath: string, ttlSeconds: number): Promise<string>;
  pepper: string;
  urlTtlSeconds: number;
  joinUrl: string;
}

export async function handleRedeem(request: Request, deps: RedeemDeps | null): Promise<Response> {
  const rid = requestId();
  if (!deps) return jsonError(503, "not_configured", "Codes can't be redeemed right now.");
  try {
    const user = await deps.authenticate(request);
    if (!user) return jsonError(401, "unauthenticated", "Sign in to Riddlebound to use this code.", {}, { joinUrl: deps.joinUrl });

    let code: unknown;
    try {
      ({ code } = (await request.json()) as { code?: unknown });
    } catch {
      return jsonError(400, "bad_request", "The request wasn't valid JSON.");
    }
    if (typeof code !== "string" || code.trim().length < 3 || code.length > 40) {
      return jsonError(400, "bad_request", "Type the code first.");
    }

    const ip = clientIp(request.headers);
    const [byIp, byUser] = await Promise.all([
      rateLimit(`redeem:ip:${ip}`, REDEEMS_PER_MINUTE, 60_000),
      rateLimit(`redeem:user:${user.id}`, REDEEMS_PER_MINUTE, 60_000),
    ]);
    if (!byIp.allowed || !byUser.allowed) {
      const retry = Math.max(byIp.allowed ? 0 : byIp.retryAfterSeconds, byUser.allowed ? 0 : byUser.retryAfterSeconds);
      log("redeem_rate_limited", { rid, user: user.id, ip });
      return jsonError(429, "too_many_attempts", "You've tried 5 codes in the last minute. Try again in a minute.", { "Retry-After": String(retry) });
    }

    const found = await deps.findCode(hashCode(deps.pepper, code));
    if (!found) {
      log("redeem_unknown", { rid, user: user.id });
      return jsonError(404, "unknown_code", "That code isn't active. Check it and try again.");
    }

    if (!(await deps.hasAccess(user.id, found.book_id))) {
      log("redeem_no_access", { rid, user: user.id, book: found.book_id });
      return jsonError(403, "no_access", "This file is for Riddlebound members. Join to open it.", {}, { joinUrl: deps.joinUrl, requiresSubscription: true });
    }

    const firstTime = await deps.recordUnlock(user.id, found.book_id, found.asset_id);
    const url = await deps.signedUrl(found.encrypted_content_url, deps.urlTtlSeconds);
    log("redeem_ok", { rid, user: user.id, book: found.book_id, asset: found.asset_id, firstTime });
    return jsonOk({ unlocked: true, firstTime, bookId: found.book_id, assetId: found.asset_id, contentUrl: url, expiresInSeconds: deps.urlTtlSeconds });
  } catch (error) {
    log("redeem_error", { rid, error: error instanceof Error ? error.message : String(error) });
    return jsonError(500, "server_error", `Something went wrong on our side. Please try again. (ref ${rid.slice(0, 8)})`);
  }
}
