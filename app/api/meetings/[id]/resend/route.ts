import { after } from "next/server";
import { isAuthed } from "@/lib/auth";
import { q } from "@/lib/db";
import { env } from "@/lib/env";
import { isUuid, unauthorized } from "@/lib/http";
import { processMeeting } from "@/lib/pipeline";
import { seeOther } from "@/lib/redirect";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Vuelve a enviar el correo (sin repetir transcripción ni análisis). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAuthed(req))) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return seeOther(req, "/dashboard");
  await q(
    "UPDATE meetings SET emailed_at = NULL, email_to = NULL, status = 'failed', stage = 'emailing' WHERE id = $1 AND status IN ('done','failed') AND analysis IS NOT NULL",
    [id],
  );
  const base = env.appUrl() ?? new URL(req.url).origin;
  after(() => processMeeting(id, base));
  return seeOther(req, `/dashboard/meetings/${id}?queued=1`);
}
