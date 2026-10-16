import { hashAnswer, sameHash } from "./answers";
import { clientIp, jsonError, jsonOk, log, requestId } from "./http";
import { rateLimit } from "./ratelimit";

// POST /api/books/unlock — the whole flow, with its dependencies injected so
// it can be tested without a network. The route file wires in Supabase.
//
// Order of checks (cheapest and safest first):
//   1. Who is asking: Supabase access token (401). The user id comes from
//      the verified token; a userId in the body must match it (403).
//   2. Input shape (400).
//   3. Rate limit: 5 submissions per minute per IP AND per user (429),
//      before any database work, so a script can't hammer the database.
//   4. Entitlement: active membership, or a purchase of this book (403).
//   5. Puzzle exists (404).
//   6. Answer: keyed SHA-256 (HMAC) of the normalized answer, compared in
//      constant time with the stored hash (400 if wrong).
//   7. Record the unlock (progress + permanent history), then return a
//      short-lived signed link to the content.

export const SUBMISSIONS_PER_MINUTE = 5;
const ID_RE = /^[a-z0-9-]{1,64}$/;

export interface UnlockDeps {
  authenticate(request: Request): Promise<{ id: string } | null>;
  hasAccess(userId: string, bookId: string): Promise<boolean>;
  getAsset(bookId: string, assetId: string): Promise<{ hashed_answer: string; encrypted_content_url: string } | null>;
  recordUnlock(userId: string, bookId: string, assetId: string): Promise<boolean>;
  signedUrl(objectPath: string, ttlSeconds: number): Promise<string>;
  pepper: string;
  urlTtlSeconds: number;
}

type Body = { userId?: unknown; bookId?: unknown; assetId?: unknown; submittedAnswer?: unknown };

export async function handleUnlock(request: Request, deps: UnlockDeps | null): Promise<Response> {
  const rid = requestId();
  if (!deps) return jsonError(503, "not_configured", "Unlocking is not available right now.");
  try {
    // 1. Authentication
    const user = await deps.authenticate(request);
    if (!user) return jsonError(401, "unauthenticated", "Please sign in to unlock this.");

    // 2. Input
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return jsonError(400, "bad_request", "The request wasn't valid JSON.");
    }
    const { bookId, assetId, submittedAnswer, userId } = body ?? {};
    if (typeof bookId !== "string" || !ID_RE.test(bookId) || typeof assetId !== "string" || !ID_RE.test(assetId)) {
      return jsonError(400, "bad_request", "That puzzle doesn't exist.");
    }
    if (typeof submittedAnswer !== "string" || submittedAnswer.trim().length === 0 || submittedAnswer.length > 200) {
      return jsonError(400, "bad_request", "Type your answer first.");
    }
    if (userId !== undefined && userId !== user.id) {
      log("unlock_user_mismatch", { rid, user: user.id });
      return jsonError(403, "forbidden", "You can only unlock puzzles for your own account.");
    }

    // 3. Rate limits (both must pass; every submission counts, right or wrong)
    const ip = clientIp(request.headers);
    const [byIp, byUser] = await Promise.all([
      rateLimit(`unlock:ip:${ip}`, SUBMISSIONS_PER_MINUTE, 60_000),
      rateLimit(`unlock:user:${user.id}`, SUBMISSIONS_PER_MINUTE, 60_000),
    ]);
    if (!byIp.allowed || !byUser.allowed) {
      const retry = Math.max(byIp.allowed ? 0 : byIp.retryAfterSeconds, byUser.allowed ? 0 : byUser.retryAfterSeconds);
      log("unlock_rate_limited", { rid, user: user.id, ip });
      return jsonError(429, "too_many_attempts", "You've tried 5 codes in the last minute. Take a breath and try again in a minute.", {
        "Retry-After": String(retry),
      });
    }

    // 4. Entitlement
    if (!(await deps.hasAccess(user.id, bookId))) {
      return jsonError(403, "no_access", "This puzzle is part of a book you haven't unlocked yet. Join Riddlebound or buy the book to play it.");
    }

    // 5. Puzzle
    const asset = await deps.getAsset(bookId, assetId);
    if (!asset) return jsonError(404, "not_found", "That puzzle doesn't exist.");

    // 6. Answer check
    const submittedHash = hashAnswer(deps.pepper, bookId, assetId, submittedAnswer);
    if (!sameHash(submittedHash, asset.hashed_answer)) {
      log("unlock_wrong", { rid, user: user.id, book: bookId, asset: assetId });
      return jsonError(400, "incorrect", "That code isn't right. Check the clue and try again.");
    }

    // 7. Record and deliver
    const firstTime = await deps.recordUnlock(user.id, bookId, assetId);
    const url = await deps.signedUrl(asset.encrypted_content_url, deps.urlTtlSeconds);
    log("unlock_ok", { rid, user: user.id, book: bookId, asset: assetId, firstTime });
    return jsonOk({ unlocked: true, firstTime, contentUrl: url, expiresInSeconds: deps.urlTtlSeconds });
  } catch (error) {
    log("unlock_error", { rid, error: error instanceof Error ? error.message : String(error) });
    return jsonError(500, "server_error", `Something went wrong on our side. Please try again. (ref ${rid.slice(0, 8)})`);
  }
}
