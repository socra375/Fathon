import { checkPassword, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { seeOther } from "@/lib/redirect";

export const dynamic = "force-dynamic";

// Freno simple a la fuerza bruta (por instancia).
const attempts = new Map<string, { n: number; until: number }>();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.until > now && a.n >= 5) return seeOther(req, "/login?error=locked");

  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  if (!checkPassword(password)) {
    const n = a && a.until > now ? a.n + 1 : 1;
    attempts.set(ip, { n, until: now + 15 * 60_000 });
    return seeOther(req, "/login?error=1");
  }
  attempts.delete(ip);
  const res = seeOther(req, "/dashboard");
  const o = sessionCookieOptions;
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${createSessionToken()}; Path=${o.path}; Max-Age=${o.maxAge}; HttpOnly; SameSite=Lax${o.secure ? "; Secure" : ""}`,
  );
  return res;
}
