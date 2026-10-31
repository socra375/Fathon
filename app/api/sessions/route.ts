import { checkApiKey } from "@/lib/auth";
import { q } from "@/lib/db";
import { isValidTimeZone } from "@/lib/format";
import { json, preflight, unauthorized } from "@/lib/http";

export const dynamic = "force-dynamic";

const PLATFORMS = new Set(["meet", "teams", "zoom", "other"]);

export function OPTIONS() {
  return preflight();
}

/** La extensión abre una grabación nueva. */
export async function POST(req: Request) {
  if (!checkApiKey(req)) return unauthorized();
  let body: { platform?: string; title?: string; url?: string; timezone?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* cuerpo vacío permitido */
  }
  const platform = PLATFORMS.has(body.platform ?? "") ? body.platform! : "other";
  const title = String(body.title ?? "").slice(0, 300);
  let url: string | null = null;
  try {
    if (body.url) {
      const u = new URL(body.url);
      url = `${u.origin}${u.pathname}`.slice(0, 500); // sin query: puede llevar tokens
    }
  } catch {
    url = null;
  }
  const timezone = isValidTimeZone(body.timezone) ? body.timezone! : null;
  const [row] = await q<{ id: string }>(
    "INSERT INTO meetings (platform, title, meeting_url, timezone) VALUES ($1, $2, $3, $4) RETURNING id",
    [platform, title, url, timezone],
  );
  return json({ id: row.id }, 201);
}
