import { q } from "./db";
import { env } from "./env";

export type TranscriptionLanguage = "es" | "en" | "multi";
export type ReportLanguage = "es" | "en";

export interface Settings {
  emailTo: string;
  transcriptionLanguage: TranscriptionLanguage;
  reportLanguage: ReportLanguage;
  keepAudio: boolean;
}

const DEFAULTS = (): Settings => ({
  emailTo: env.emailTo() ?? "",
  transcriptionLanguage: "multi",
  reportLanguage: "es",
  keepAudio: false,
});

export async function getSettings(): Promise<Settings> {
  const rows = await q<{ key: string; value: string }>("SELECT key, value FROM settings");
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const d = DEFAULTS();
  const tl = map.get("transcription_language");
  const rl = map.get("report_language");
  return {
    emailTo: map.get("email_to") || d.emailTo,
    transcriptionLanguage: tl === "es" || tl === "en" || tl === "multi" ? tl : d.transcriptionLanguage,
    reportLanguage: rl === "es" || rl === "en" ? rl : d.reportLanguage,
    keepAudio: map.has("keep_audio") ? map.get("keep_audio") === "true" : d.keepAudio,
  };
}

export async function saveSettings(s: Partial<Settings>): Promise<void> {
  const pairs: [string, string][] = [];
  if (s.emailTo !== undefined) pairs.push(["email_to", s.emailTo.trim()]);
  if (s.transcriptionLanguage) pairs.push(["transcription_language", s.transcriptionLanguage]);
  if (s.reportLanguage) pairs.push(["report_language", s.reportLanguage]);
  if (s.keepAudio !== undefined) pairs.push(["keep_audio", String(s.keepAudio)]);
  for (const [key, value] of pairs) {
    await q(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }
}

export function isValidEmailList(v: string): boolean {
  const parts = v.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.length <= 10 && parts.every((p) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(p));
}
