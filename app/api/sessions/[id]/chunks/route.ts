import { checkApiKey } from "@/lib/auth";
import { q } from "@/lib/db";
import { isUuid, json, preflight, unauthorized } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // por debajo del límite de 4,5 MB de Vercel
const MAX_SEQ = 20_000; // ~83 h con fragmentos de 15 s
const TRACKS = new Set(["tab", "mic", "mix"]);
const MAX_SEG_START_MS = 24 * 3600 * 1000;

export function OPTIONS() {
  return preflight();
}

/**
 * Recibe un fragmento de audio (WebM/Opus). Idempotente.
 * Query: seq (orden dentro de la pista), track (tab | mic | mix), seg (segmento) y
 * segStart (ms desde el inicio de la reunión en que empezó el segmento).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!checkApiKey(req)) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "id no válido" }, 400);
  const sp = new URL(req.url).searchParams;
  const seq = Number(sp.get("seq"));
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return json({ error: "seq no válido" }, 400);
  const track = sp.get("track") ?? "mix";
  if (!TRACKS.has(track)) return json({ error: "track no válido" }, 400);
  const seg = Number(sp.get("seg") ?? 0);
  if (!Number.isInteger(seg) || seg < 0 || seg > MAX_SEQ) return json({ error: "seg no válido" }, 400);
  const segStart = Number(sp.get("segStart") ?? 0);
  if (!Number.isInteger(segStart) || segStart < 0 || segStart > MAX_SEG_START_MS) return json({ error: "segStart no válido" }, 400);

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) return json({ error: "fragmento vacío" }, 400);
  if (buf.length > MAX_CHUNK_BYTES) return json({ error: "fragmento demasiado grande" }, 413);

  const meeting = await q<{ status: string }>("SELECT status FROM meetings WHERE id = $1", [id]);
  if (!meeting[0]) return json({ error: "reunión no encontrada" }, 404);
  if (meeting[0].status !== "recording") return json({ error: "la grabación ya terminó" }, 409);

  const inserted = await q(
    `INSERT INTO audio_chunks (meeting_id, track, seq, seg, seg_start_ms, data)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING seq`,
    [id, track, seq, seg, segStart, buf],
  );
  if (inserted.length > 0) {
    await q(
      "UPDATE meetings SET chunk_count = chunk_count + 1, audio_bytes = audio_bytes + $2, updated_at = now() WHERE id = $1",
      [id, buf.length],
    );
  }
  return json({ ok: true, track, seq, seg, duplicate: inserted.length === 0 });
}
