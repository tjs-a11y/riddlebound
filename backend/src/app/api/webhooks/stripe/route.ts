import type Stripe from "stripe";
import { adminClient } from "@/lib/supabase";
import { stripeClient } from "@/lib/stripe";
import { jsonError, log } from "@/lib/http";
import { syncEvent, type SyncDb } from "@/lib/stripe-sync";

// POST /api/webhooks/stripe — Stripe calls this; nobody else can, because
// every request's signature is checked against STRIPE_WEBHOOK_SECRET using
// the RAW body (parsing it first would break the signature).
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const client = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const db = adminClient();
  if (!client || !secret || !db) return jsonError(503, "not_configured", "Webhook not configured.");

  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = client.webhooks.constructEvent(raw, request.headers.get("stripe-signature") ?? "", secret);
  } catch {
    log("stripe_signature_rejected", { bytes: raw.length });
    return jsonError(400, "bad_signature", "Invalid signature.");
  }

  const rpc: SyncDb = {
    async rpc(fn, args) {
      const { data, error } = await db.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data;
    },
  };
  const { status, result } = await syncEvent(rpc, event);
  return Response.json({ received: true, result }, { status, headers: { "Cache-Control": "no-store" } });
}
