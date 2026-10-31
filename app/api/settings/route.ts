import { isAuthed } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { seeOther } from "@/lib/redirect";
import { isValidEmailList, saveSettings, type ReportLanguage, type TranscriptionLanguage } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!(await isAuthed(req))) return unauthorized();
  const form = await req.formData();
  const emailTo = String(form.get("emailTo") ?? "").trim();
  if (emailTo && !isValidEmailList(emailTo)) return seeOther(req, "/dashboard?settings=invalid-email");
  const tl = String(form.get("transcriptionLanguage") ?? "");
  const rl = String(form.get("reportLanguage") ?? "");
  await saveSettings({
    emailTo,
    transcriptionLanguage: (["es", "en", "multi"].includes(tl) ? tl : "multi") as TranscriptionLanguage,
    reportLanguage: (["es", "en"].includes(rl) ? rl : "es") as ReportLanguage,
    keepAudio: form.get("keepAudio") === "on",
  });
  return seeOther(req, "/dashboard?settings=saved");
}
