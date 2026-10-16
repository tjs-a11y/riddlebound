// The reader pages live on riddlebound.app (static, GitHub Pages) and call this API on another
// origin, so the browser needs CORS. Only the Riddlebound site may call; the Stripe webhook never
// uses CORS (server to server). Tokens travel in the Authorization header, never in cookies.

const DEFAULT_ORIGINS = "https://riddlebound.app,https://www.riddlebound.app";

export function allowedOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.RIDDLEBOUND_SITE_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));
}

function corsHeaders(request: Request, methods: string): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins().has(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// Answers the browser's preflight. Unknown origins get no CORS headers, so the browser blocks them.
export function preflight(request: Request, methods = "POST"): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, methods) });
}

export function withCors(request: Request, response: Response, methods = "POST"): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, methods))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
