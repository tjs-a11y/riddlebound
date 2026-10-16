import { adminClient } from "@/lib/supabase";
import { handleMe } from "@/lib/account";
import { accountDeps } from "@/lib/stripe";
import { preflight, withCors } from "@/lib/cors";

// GET /api/me  The signed-in reader's membership and books. See src/lib/account.ts.
export const dynamic = "force-dynamic";

export const OPTIONS = (request: Request): Response => preflight(request, "GET");

export async function GET(request: Request): Promise<Response> {
  return withCors(request, await handleMe(request, accountDeps(adminClient())), "GET");
}
