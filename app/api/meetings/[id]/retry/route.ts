import { after } from "next/server";
import { checkApiKey, isAuthed } from "@/lib/auth";
import { env } from "@/lib/env";
import { isUuid, unauthorized } from "@/lib/http";
import { processMeeting } from "@/lib/pipeline";
import { seeOther } from "@/lib/redirect";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Reintenta el procesamiento desde el paso donde falló (o procesa una grabación abandonada).
 * Con ?continue=1 (solo con la clave del servidor) continúa una ejecución que agotó su tiempo.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed(req))) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return seeOther(req, "/dashboard");
  const continuation = new URL(req.url).searchParams.get("continue") === "1";
  if (continuation && !checkApiKey(req)) return unauthorized();
  const base = env.appUrl() ?? new URL(req.url).origin;
  after(() => processMeeting(id, base, { continuation }));
  return seeOther(req, `/dashboard/meetings/${id}?queued=1`);
}
