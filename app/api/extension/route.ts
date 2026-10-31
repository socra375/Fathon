import JSZip from "jszip";
import { isDashboardAuthed } from "@/lib/auth";
import { env } from "@/lib/env";
import { EXTENSION_FILES } from "@/lib/generated/assets";

export const dynamic = "force-dynamic";

/**
 * Descarga la extensión ya configurada: lleva dentro la dirección del servidor y la
 * clave, así que solo hay que descomprimirla y cargarla en Chrome. Requiere sesión.
 */
export async function GET(req: Request) {
  if (!(await isDashboardAuthed())) {
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }
  const apiKey = env.apiKey();
  if (!apiKey) return new Response("Falta MINUTA_API_KEY en el servidor", { status: 500 });
  const serverUrl = env.appUrl() ?? new URL(req.url).origin;
  const origin = new URL(serverUrl).origin;

  const zip = new JSZip();
  const folder = zip.folder("minuta-extension")!;
  for (const [file, b64] of Object.entries(EXTENSION_FILES)) {
    if (file === "config.js") {
      folder.file(
        file,
        `// Generado por tu panel de Minuta. Contiene tu clave privada: no lo compartas.\n` +
          `export const CONFIG = ${JSON.stringify({ serverUrl: origin, apiKey }, null, 2)};\n`,
      );
    } else if (file === "manifest.json") {
      const manifest = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      manifest.host_permissions = [`${origin}/*`];
      folder.file(file, JSON.stringify(manifest, null, 2));
    } else {
      folder.file(file, Buffer.from(b64, "base64"));
    }
  }
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="minuta-extension.zip"',
      "Cache-Control": "no-store",
    },
  });
}
