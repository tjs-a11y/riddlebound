import { jsonError, jsonOk, log, requestId } from "./http";

// GET  /api/me              what the signed-in reader has: membership (and until when) and owned books.
// POST /api/billing/portal  a Stripe Customer Portal link to change card, switch plan or cancel.
// Both: Authorization: Bearer <Supabase access token>.

export interface AccountDeps {
  authenticate(request: Request): Promise<{ id: string; email: string | null } | null>;
  entitlements(userId: string): Promise<{ type: string; book_id: string | null; expires_at: string | null }[]>;
  customerId(userId: string): Promise<string | null>;
  portalUrl(customer: string, returnUrl: string): Promise<string>;
  siteUrl: string;
}

export async function handleMe(request: Request, deps: AccountDeps | null, now = Date.now()): Promise<Response> {
  const rid = requestId();
  if (!deps) return jsonError(503, "not_configured", "Accounts aren't open yet.");
  try {
    const user = await deps.authenticate(request);
    if (!user) return jsonError(401, "unauthenticated", "Sign in to see your account.");
    const rows = await deps.entitlements(user.id);
    const live = (r: { expires_at: string | null }) => r.expires_at === null || Date.parse(r.expires_at) > now;
    const m = rows.find((r) => r.type === "membership_active");
    return jsonOk({
      email: user.email,
      member: !!m && live(m),
      memberUntil: m?.expires_at ?? null,
      books: rows.filter((r) => r.type === "single_book_purchase" && live(r)).map((r) => r.book_id),
      billing: (await deps.customerId(user.id)) !== null,
    });
  } catch (error) {
    log("me_error", { rid, error: error instanceof Error ? error.message : String(error) });
    return jsonError(500, "server_error", `Something went wrong on our side. (ref ${rid.slice(0, 8)})`);
  }
}

export async function handlePortal(request: Request, deps: AccountDeps | null): Promise<Response> {
  const rid = requestId();
  if (!deps) return jsonError(503, "not_configured", "Accounts aren't open yet.");
  try {
    const user = await deps.authenticate(request);
    if (!user) return jsonError(401, "unauthenticated", "Sign in to manage your membership.");
    const customer = await deps.customerId(user.id);
    if (!customer) return jsonError(404, "no_billing", "There's no membership on this account yet.");
    return jsonOk({ url: await deps.portalUrl(customer, `${deps.siteUrl}/account/`) });
  } catch (error) {
    log("portal_error", { rid, error: error instanceof Error ? error.message : String(error) });
    return jsonError(500, "server_error", `Something went wrong on our side. (ref ${rid.slice(0, 8)})`);
  }
}
