import { after } from "next/server";
import { isAuthed } from "@/lib/auth";
import { env } from "@/lib/env";
import { isUuid, unauthorized } from "@/lib/http";
import { processMeeting } from "@/lib/pipeline";
import { seeOther } from "@/lib/redirect";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Reintenta el procesamiento desde el paso donde falló (o procesa una grabación abandonada). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed(req))) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return seeOther(req, "/dashboard");
  const base = env.appUrl() ?? new URL(req.url).origin;
  after(() => processMeeting(id, base));
  return seeOther(req, `/dashboard/meetings/${id}?queued=1`);
}
