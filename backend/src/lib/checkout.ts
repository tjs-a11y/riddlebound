import { jsonError, jsonOk, log, requestId } from "./http";
import { rateLimit } from "./ratelimit";
import { PRODUCT } from "./stripe-sync";

// POST /api/checkout  { plan: "month" | "year" | "book", bookId? }
// Header: Authorization: Bearer <Supabase access token>
//
// Opens a Stripe Checkout page for the signed-in reader and returns its address.
//   1. Sign-in (401). The member comes from the verified token only, never from the body.
//   2. Input (400) and rate limit (429): 10 checkouts a minute per member.
//   3. Nothing to buy twice (409): an active member can't start a second membership, and
//      nobody pays for a book they can already read.
//   4. The member's Stripe customer is created (or reused) and linked to their profile BEFORE
//      checkout, so the subscription events that follow always find their member.
//   5. The session carries client_reference_id + metadata.product = "riddlebound" (and the
//      same metadata on the subscription), which is what the webhook acts on.
// Prices are found by lookup key, so changing a price never needs a code change.

export const CHECKOUTS_PER_MINUTE = 10;
export const LOOKUP_KEYS = {
  month: "riddlebound__member__month",
  year: "riddlebound__member__year",
  book: "riddlebound__book__once",
} as const;
export type Plan = keyof typeof LOOKUP_KEYS;
const BOOK_RE = /^[a-z0-9-]{1,64}$/;

export interface SessionParams {
  mode: "subscription" | "payment";
  price: string;
  customer: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
  subscriptionMetadata: Record<string, string> | null;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutDeps {
  authenticate(request: Request): Promise<{ id: string; email: string | null } | null>;
  isMember(userId: string): Promise<boolean>;
  hasBook(userId: string, bookId: string): Promise<boolean>;
  booksForSale: Set<string>;
  // Existing customer id, or a new one linked to the member. null: the link conflicts (needs a human).
  customerFor(user: { id: string; email: string | null }): Promise<string | null>;
  priceFor(lookupKey: string): Promise<string | null>;
  createSession(params: SessionParams): Promise<string>;
  siteUrl: string;
}

export async function handleCheckout(request: Request, deps: CheckoutDeps | null): Promise<Response> {
  const rid = requestId();
  if (!deps) return jsonError(503, "not_configured", "Joining isn't open yet. Please try again soon.");
  try {
    const user = await deps.authenticate(request);
    if (!user) return jsonError(401, "unauthenticated", "Sign in first, then choose your plan.");

    let body: { plan?: unknown; bookId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonError(400, "bad_request", "The request wasn't valid JSON.");
    }
    const plan = body?.plan;
    if (plan !== "month" && plan !== "year" && plan !== "book") return jsonError(400, "bad_request", "Choose monthly, yearly or a single book.");
    const bookId = plan === "book" ? body.bookId : null;
    if (plan === "book" && (typeof bookId !== "string" || !BOOK_RE.test(bookId))) return jsonError(400, "bad_request", "Choose a book.");

    const limit = await rateLimit(`checkout:user:${user.id}`, CHECKOUTS_PER_MINUTE, 60_000);
    if (!limit.allowed) return jsonError(429, "too_many_attempts", "Too many tries. Wait a minute and try again.", { "Retry-After": String(limit.retryAfterSeconds) });

    if (plan === "book" && !deps.booksForSale.has(bookId as string)) return jsonError(404, "not_for_sale", "That book isn't on sale yet.");
    if (await deps.isMember(user.id)) {
      return jsonError(409, "already_member", "You're already a member, so every book is open to you.", {}, { accountUrl: `${deps.siteUrl}/account/` });
    }
    if (plan === "book" && (await deps.hasBook(user.id, bookId as string))) {
      return jsonError(409, "already_owned", "You already own this book.", {}, { accountUrl: `${deps.siteUrl}/account/` });
    }

    const price = await deps.priceFor(LOOKUP_KEYS[plan]);
    if (!price) {
      log("checkout_no_price", { rid, plan });
      return jsonError(503, "not_configured", "That plan isn't available right now.");
    }
    const customer = await deps.customerFor(user);
    if (!customer) {
      log("checkout_customer_conflict", { rid, user: user.id });
      return jsonError(409, "account_conflict", `We couldn't match your billing account. Email us and quote ref ${rid.slice(0, 8)}.`);
    }

    const metadata: Record<string, string> = { product: PRODUCT, plan };
    if (plan === "book") Object.assign(metadata, { purchase_type: "single_book", book_id: bookId as string });
    const url = await deps.createSession({
      mode: plan === "book" ? "payment" : "subscription",
      price,
      customer,
      clientReferenceId: user.id,
      metadata,
      subscriptionMetadata: plan === "book" ? null : { product: PRODUCT, plan },
      successUrl: `${deps.siteUrl}/account/?welcome=1`,
      cancelUrl: `${deps.siteUrl}/join/?canceled=1`,
    });
    log("checkout_created", { rid, user: user.id, plan, book: bookId });
    return jsonOk({ url });
  } catch (error) {
    log("checkout_error", { rid, error: error instanceof Error ? error.message : String(error) });
    return jsonError(500, "server_error", `Something went wrong on our side. Please try again. (ref ${rid.slice(0, 8)})`);
  }
}
