/** Utilidades para las rutas API: CORS para la extensión y respuestas JSON. */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const base: ResponseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(base.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { ...base, headers });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function unauthorized(): Response {
  return json({ error: "No autorizado" }, 401);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
