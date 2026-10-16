import { createHmac, timingSafeEqual } from "node:crypto";

// Puzzle answers are compared as keyed hashes, never as plain text.
//
// Normalization: Unicode NFKD, accents removed, lowercase, then everything
// that isn't a-z or 0-9 removed. So "Write it up", "WRITE-IT-UP" and
// "writeitup" all match. The editions tool applies the same rule when it
// prints codes, so the hashes it exports and these checks agree.
export function normalizeAnswer(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// HMAC-SHA256 keyed with a server-only secret ("pepper"), bound to the book
// and asset, so the same answer hashes differently in every puzzle and a
// leaked hash can't be brute-forced without the secret.
export function hashAnswer(pepper: string, bookId: string, assetId: string, answer: string): string {
  if (pepper.length < 32) throw new Error("RIDDLEBOUND_ANSWER_PEPPER must be at least 32 characters");
  return createHmac("sha256", pepper).update(`${bookId}:${assetId}:${normalizeAnswer(answer)}`).digest("hex");
}

// Constant-time comparison of two hex digests.
export function sameHash(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// Redeemable codes (0002): one hash per code, not bound to a puzzle, so the server can look a
// typed code up directly. Same pepper and normalization as answers ("GHOST-ZERO" = "ghost zero").
export function hashCode(pepper: string, code: string): string {
  if (pepper.length < 32) throw new Error("RIDDLEBOUND_ANSWER_PEPPER must be at least 32 characters");
  return createHmac("sha256", pepper).update(`code:${normalizeAnswer(code)}`).digest("hex");
}
