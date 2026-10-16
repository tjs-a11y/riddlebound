import { adminClient, userFromRequest } from "@/lib/supabase";
import { handleUnlock, type UnlockDeps } from "@/lib/unlock";

// POST /api/books/unlock  { bookId, assetId, submittedAnswer, userId? }
// Header: Authorization: Bearer <Supabase access token>. See src/lib/unlock.ts.
export const dynamic = "force-dynamic";

function deps(): UnlockDeps | null {
  const db = adminClient();
  const pepper = process.env.RIDDLEBOUND_ANSWER_PEPPER ?? "";
  if (!db || pepper.length < 32) return null;
  const ttl = Math.min(3600, Math.max(60, Number(process.env.UNLOCK_URL_TTL_SECONDS ?? 300) || 300));
  return {
    pepper,
    urlTtlSeconds: ttl,
    authenticate: (request) => userFromRequest(request, db),
    async hasAccess(userId, bookId) {
      const { data, error } = await db.rpc("rb_has_book_access", { p_user: userId, p_book: bookId });
      if (error) throw new Error(`access check failed: ${error.message}`);
      return data === true;
    },
    async getAsset(bookId, assetId) {
      const { data, error } = await db
        .from("book_assets")
        .select("hashed_answer, encrypted_content_url")
        .eq("book_id", bookId)
        .eq("asset_id", assetId)
        .maybeSingle();
      if (error) throw new Error(`asset lookup failed: ${error.message}`);
      return data;
    },
    async recordUnlock(userId, bookId, assetId) {
      const { data, error } = await db.rpc("rb_record_unlock", { p_user: userId, p_book: bookId, p_asset: assetId });
      if (error) throw new Error(`record unlock failed: ${error.message}`);
      return data === true;
    },
    async signedUrl(objectPath, ttlSeconds) {
      // "bucket/path/to/file" in a PRIVATE Storage bucket -> a link that works for ttlSeconds only.
      const slash = objectPath.indexOf("/");
      if (slash < 1) throw new Error("content path must be bucket/path");
      const { data, error } = await db.storage.from(objectPath.slice(0, slash)).createSignedUrl(objectPath.slice(slash + 1), ttlSeconds);
      if (error || !data?.signedUrl) throw new Error(`signing failed: ${error?.message ?? "no url"}`);
      return data.signedUrl;
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  return handleUnlock(request, deps());
}
