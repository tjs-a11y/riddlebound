import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-side Supabase access with the SECRET key (skips row-level security).
// Used only after this server has checked who the caller is and what they may do.
let admin: SupabaseClient | null | undefined;
export function adminClient(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  return admin;
}

// The signed-in reader, from the Supabase access token in "Authorization: Bearer ...".
// The token is verified by Supabase Auth; the user id is never taken from the request body.
export async function userFromRequest(request: Request, client: SupabaseClient): Promise<{ id: string } | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
  if (!match) return null;
  const { data, error } = await client.auth.getUser(match[1]);
  if (error || !data?.user?.id) return null;
  return { id: data.user.id };
}
