import { preflight, withCors } from "@/lib/cors";
import { adminClient, userFromRequest } from "@/lib/supabase";
import { handleRedeem, type RedeemDeps } from "@/lib/redeem";

// POST /api/codes/redeem  { code }  Header: Authorization: Bearer <Supabase access token>. See src/lib/redeem.ts.
export const dynamic = "force-dynamic";

export const OPTIONS = (request: Request): Response => preflight(request);

function deps(): RedeemDeps | null {
  const db = adminClient();
  const pepper = process.env.RIDDLEBOUND_ANSWER_PEPPER ?? "";
  if (!db || pepper.length < 32) return null;
  const ttl = Math.min(3600, Math.max(60, Number(process.env.UNLOCK_URL_TTL_SECONDS ?? 300) || 300));
  return {
    pepper,
    urlTtlSeconds: ttl,
    joinUrl: process.env.RIDDLEBOUND_JOIN_URL || "https://riddlebound.app/join/",
    authenticate: (request) => userFromRequest(request, db),
    async findCode(codeHash) {
      const { data, error } = await db
        .from("redeem_codes")
        .select("book_id, asset_id, active, book_assets(encrypted_content_url)")
        .eq("code_hash", codeHash)
        .maybeSingle();
      if (error) throw new Error(`code lookup failed: ${error.message}`);
      const asset = Array.isArray(data?.book_assets) ? data?.book_assets[0] : data?.book_assets;
      if (!data || !data.active || !asset) return null;
      return { book_id: data.book_id, asset_id: data.asset_id, encrypted_content_url: asset.encrypted_content_url };
    },
    async hasAccess(userId, bookId) {
      const { data, error } = await db.rpc("rb_has_book_access", { p_user: userId, p_book: bookId });
      if (error) throw new Error(`access check failed: ${error.message}`);
      return data === true;
    },
    async recordUnlock(userId, bookId, assetId) {
      const { data, error } = await db.rpc("append_unlocked_code_to_progress", { p_user_id: userId, p_book_id: bookId, p_code: assetId });
      if (error) throw new Error(`record unlock failed: ${error.message}`);
      return data === true;
    },
    async signedUrl(objectPath, ttlSeconds) {
      const slash = objectPath.indexOf("/");
      if (slash < 1) throw new Error("content path must be bucket/path");
      const { data, error } = await db.storage.from(objectPath.slice(0, slash)).createSignedUrl(objectPath.slice(slash + 1), ttlSeconds);
      if (error || !data?.signedUrl) throw new Error(`signing failed: ${error?.message ?? "no url"}`);
      return data.signedUrl;
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  return withCors(request, await handleRedeem(request, deps()));
}
