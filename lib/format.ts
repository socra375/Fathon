export interface Utterance {
  start: number; // segundos
  end: number;
  speaker: number; // 0-based
  text: string;
}

export function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

export function speakerLabel(speaker: number, lang: "es" | "en" = "es"): string {
  return `${lang === "en" ? "Speaker" : "Hablante"} ${speaker + 1}`;
}

/** Une frases consecutivas del mismo hablante para que la transcripción sea legible. */
export function mergeUtterances(utts: Utterance[], maxGapSec = 2): Utterance[] {
  const out: Utterance[] = [];
  for (const u of utts) {
    const text = u.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === u.speaker && u.start - last.end <= maxGapSec) {
      last.text = `${last.text} ${text}`;
      last.end = u.end;
    } else {
      out.push({ ...u, text });
    }
  }
  return out;
}

export function transcriptToText(utts: Utterance[], lang: "es" | "en" = "es"): string {
  return utts.map((u) => `[${clock(u.start)}] ${speakerLabel(u.speaker, lang)}: ${u.text}`).join("\n");
}

export interface TalkShare {
  speaker: number;
  seconds: number;
  pct: number;
  turns: number;
  words: number;
}

/** Tiempo de palabra por hablante, calculado de la transcripción (no lo estima la IA). */
export function talkShares(utts: Utterance[]): TalkShare[] {
  const by = new Map<number, TalkShare>();
  for (const u of utts) {
    const cur = by.get(u.speaker) ?? { speaker: u.speaker, seconds: 0, pct: 0, turns: 0, words: 0 };
    cur.seconds += Math.max(0, u.end - u.start);
    cur.turns += 1;
    cur.words += u.text.split(/\s+/).filter(Boolean).length;
    by.set(u.speaker, cur);
  }
  const total = [...by.values()].reduce((a, b) => a + b.seconds, 0) || 1;
  return [...by.values()]
    .map((t) => ({ ...t, seconds: Math.round(t.seconds), pct: Math.round((t.seconds / total) * 100) }))
    .sort((a, b) => b.seconds - a.seconds);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const PLATFORM_NAMES: Record<string, string> = {
  meet: "Google Meet",
  teams: "Microsoft Teams",
  zoom: "Zoom",
  other: "Reunión",
};

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("es", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fecha legible en la zona horaria de quien grabó (UTC si no se conoce). */
export function formatDate(d: Date | string, timeZone?: string | null, locale = "es-ES"): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const s = new Date(d).toLocaleString(locale, { dateStyle: "long", timeStyle: "short", timeZone: tz });
  return tz === "UTC" ? `${s} (UTC)` : s;
}
