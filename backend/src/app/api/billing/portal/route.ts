import { adminClient } from "@/lib/supabase";
import { handlePortal } from "@/lib/account";
import { accountDeps } from "@/lib/stripe";
import { preflight, withCors } from "@/lib/cors";

// POST /api/billing/portal  A Stripe Customer Portal link (card, plan, cancel). See src/lib/account.ts.
export const dynamic = "force-dynamic";

export const OPTIONS = (request: Request): Response => preflight(request);

export async function POST(request: Request): Promise<Response> {
  return withCors(request, await handlePortal(request, accountDeps(adminClient())));
}
