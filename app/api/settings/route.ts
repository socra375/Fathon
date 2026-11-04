import { isAuthed } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { parseRecipients, validateRecipients } from "@/lib/mailer";
import { saveSettings, type ReportLanguage, type TranscriptionLanguage } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return unauthorized();
  const form = await req.formData();
  const emailTo = String(form.get("emailTo") ?? "").trim();
  const invalid = emailTo ? validateRecipients(emailTo) : null;
  if (invalid) return seeOther(req, `/dashboard?settings=invalid-email&why=${encodeURIComponent(invalid)}`);
  const tl = String(form.get("transcriptionLanguage") ?? "");
  const rl = String(form.get("reportLanguage") ?? "");
  await saveSettings({
    emailTo: parseRecipients(emailTo).join(", "),
    transcriptionLanguage: (["es", "en", "multi"].includes(tl) ? tl : "multi") as TranscriptionLanguage,
    reportLanguage: (["es", "en"].includes(rl) ? rl : "es") as ReportLanguage,
    keepAudio: form.get("keepAudio") === "on",
  });
  return seeOther(req, "/dashboard?settings=saved");
}
