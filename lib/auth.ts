import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "./env";

export const SESSION_COOKIE = "minuta_session";
const SESSION_DAYS = 30;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Valida la cabecera `Authorization: Bearer <MINUTA_API_KEY>` que envía la extensión. */
export function checkApiKey(req: Request): boolean {
  const expected = env.apiKey();
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(m && safeEqual(m[1].trim(), expected));
}

function sign(payload: string): string {
  const secret = env.apiKey() ?? "";
  return createHmac("sha256", `minuta-session:${secret}`).update(payload).digest("base64url");
}

/** Token de sesión del panel: "<expira>.<firma>". Cambiar MINUTA_API_KEY invalida todas las sesiones. */
export function createSessionToken(now = Date.now()): string {
  const exp = String(now + SESSION_DAYS * 86_400_000);
  return `${exp}.${sign(exp)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token || !env.apiKey()) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < now) return false;
  return safeEqual(sig, sign(exp));
}

export function checkPassword(candidate: string): boolean {
  const expected = env.dashboardPassword();
  return Boolean(expected) && safeEqual(candidate, expected!);
}

export async function isDashboardAuthed(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Acepta sesión del panel (cookie) o la clave de la extensión. */
export async function isAuthed(req: Request): Promise<boolean> {
  return checkApiKey(req) || (await isDashboardAuthed());
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production" && !/^http:\/\//.test(env.appUrl() ?? ""),
  path: "/",
  maxAge: SESSION_DAYS * 86_400,
};
