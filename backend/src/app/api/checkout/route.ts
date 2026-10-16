import { adminClient } from "@/lib/supabase";
import { handleCheckout } from "@/lib/checkout";
import { checkoutDeps } from "@/lib/stripe";
import { preflight, withCors } from "@/lib/cors";

// POST /api/checkout  { plan: "month" | "year" | "book", bookId? }  See src/lib/checkout.ts.
export const dynamic = "force-dynamic";

export const OPTIONS = (request: Request): Response => preflight(request);

export async function POST(request: Request): Promise<Response> {
  return withCors(request, await handleCheckout(request, checkoutDeps(adminClient())));
}
