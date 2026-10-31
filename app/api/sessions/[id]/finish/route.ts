import { after } from "next/server";
import { checkApiKey } from "@/lib/auth";
import { q } from "@/lib/db";
import { env } from "@/lib/env";
import { isUuid, json, preflight, unauthorized } from "@/lib/http";
import { processMeeting } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export function OPTIONS() {
  return preflight();
}

/** Cierra la grabación y lanza el procesamiento en segundo plano. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkApiKey(req)) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "id no válido" }, 400);
  let durationSec: number | null = null;
  try {
    const body = (await req.json()) as { durationSec?: number };
    if (typeof body.durationSec === "number" && body.durationSec >= 0) durationSec = Math.round(body.durationSec);
  } catch {
    /* opcional */
  }
  const rows = await q<{ status: string }>(
    `UPDATE meetings SET ended_at = COALESCE(ended_at, now()),
            duration_sec = COALESCE($2, duration_sec), updated_at = now()
      WHERE id = $1 RETURNING status`,
    [id, durationSec],
  );
  if (!rows[0]) return json({ error: "reunión no encontrada" }, 404);
  if (rows[0].status === "recording" || rows[0].status === "failed") {
    const base = env.appUrl() ?? new URL(req.url).origin;
    after(() => processMeeting(id, base));
  }
  return json({ ok: true, status: "processing" }, 202);
}
