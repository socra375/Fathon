import { configStatus } from "@/lib/env";
import { q } from "@/lib/db";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/** Estado público (sin secretos): sirve para comprobar el despliegue y desde la extensión. */
export async function GET() {
  const config = configStatus();
  let db = false;
  if (config.database) {
    try {
      await q("SELECT 1");
      db = true;
    } catch {
      db = false;
    }
  }
  const ready = db && config.apiKey && config.transcription && config.anthropic && config.resend;
  return json({ ok: true, ready, db, config, app: "minuta" });
}
