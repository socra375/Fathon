import { env } from "./env";
import type { Utterance } from "./format";
import type { TranscriptionLanguage } from "./settings";

export interface TranscriptionResult {
  utterances: Utterance[];
  durationSec: number;
  language: string | null;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: {
      detected_language?: string;
      alternatives?: { transcript?: string; languages?: string[] }[];
    }[];
    utterances?: { start: number; end: number; speaker?: number; transcript: string }[];
  };
}

export class TranscriptionError extends Error {}

function buildQuery(model: string, language: TranscriptionLanguage): URLSearchParams {
  const p = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    paragraphs: "false",
  });
  if (language === "multi") {
    // nova-3 admite transcripción multilingüe; los modelos anteriores, detección de idioma.
    if (model.startsWith("nova-3")) p.set("language", "multi");
    else p.set("detect_language", "true");
  } else {
    p.set("language", language);
  }
  return p;
}

export function parseDeepgram(data: DeepgramResponse, fallbackLanguage: string | null): TranscriptionResult {
  const utts: Utterance[] = (data.results?.utterances ?? []).map((u) => ({
    start: u.start,
    end: u.end,
    speaker: typeof u.speaker === "number" ? u.speaker : 0,
    text: u.transcript ?? "",
  }));
  const ch = data.results?.channels?.[0];
  if (utts.length === 0) {
    const text = ch?.alternatives?.[0]?.transcript?.trim();
    if (text) utts.push({ start: 0, end: data.metadata?.duration ?? 0, speaker: 0, text });
  }
  const language = ch?.detected_language ?? ch?.alternatives?.[0]?.languages?.[0] ?? fallbackLanguage;
  return { utterances: utts, durationSec: Math.round(data.metadata?.duration ?? 0), language };
}

async function callDeepgram(audio: Buffer, model: string, language: TranscriptionLanguage) {
  const key = env.deepgramKey();
  if (!key) throw new TranscriptionError("Falta DEEPGRAM_API_KEY");
  const url = `${env.deepgramUrl()}/v1/listen?${buildQuery(model, language)}`;
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "audio/webm" },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(240_000),
  });
}

export async function transcribe(audio: Buffer, language: TranscriptionLanguage): Promise<TranscriptionResult> {
  const primary = env.deepgramModel();
  let res = await callDeepgram(audio, primary, language);
  // Si el modelo no admite el idioma pedido, reintenta con nova-2 + detección automática.
  if (res.status === 400 && primary !== "nova-2") {
    res = await callDeepgram(audio, "nova-2", language === "multi" ? "multi" : language);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new TranscriptionError(`Deepgram respondió ${res.status}: ${body}`);
  }
  const data = (await res.json()) as DeepgramResponse;
  return parseDeepgram(data, language === "multi" ? null : language);
}
