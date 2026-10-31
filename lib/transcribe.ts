import { env } from "./env";
import type { Utterance } from "./format";
import type { TranscriptionLanguage } from "./settings";

/**
 * Transcripción por pista.
 *
 * La extensión graba dos pistas separadas: "mic" (tu voz) y "tab" (el audio de la reunión,
 * es decir, los demás). Así se distingue «Tú» de «Otros participantes» incluso con un
 * proveedor gratuito que no separa hablantes (Whisper en Groq). Con Deepgram, además, se
 * distingue a cada participante dentro de la pista "tab".
 */

export type Track = "tab" | "mic" | "mix";
export type Provider = "groq" | "deepgram";

/** Fragmento transcrito con tiempos relativos al inicio del audio enviado. */
export interface RawSegment {
  start: number;
  end: number;
  text: string;
  /** Hablante dentro de este audio (solo si el proveedor separa hablantes). */
  speaker?: number;
}

export interface TrackResult {
  segments: RawSegment[];
  durationSec: number;
  language: string | null;
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    /** Segundos tras los que conviene reintentar (límite de uso del plan gratuito). */
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- etiquetas de hablante

export const LABEL_YOU = "Tú";
export const LABEL_OTHERS = "Otros participantes";

/**
 * Convierte los segmentos de una pista en intervenciones de la reunión: desplaza los tiempos
 * al inicio del segmento y asigna un hablante estable.
 *  - mic → 0 «Tú»
 *  - tab sin separación → 1 «Otros participantes»; con separación → 1+n «Participante n+1»
 *  - mix (versión antigua, todo mezclado) → n «Hablante n+1»
 */
export function toUtterances(track: Track, segments: RawSegment[], offsetSec: number): Utterance[] {
  return segments.map((s) => {
    const base = { start: s.start + offsetSec, end: s.end + offsetSec, text: s.text.trim() };
    if (track === "mic") return { ...base, speaker: 0, label: LABEL_YOU };
    if (track === "tab") {
      if (typeof s.speaker === "number") return { ...base, speaker: 1 + s.speaker, label: `Participante ${s.speaker + 1}` };
      return { ...base, speaker: 1, label: LABEL_OTHERS };
    }
    const n = s.speaker ?? 0;
    return { ...base, speaker: n, label: `Hablante ${n + 1}` };
  });
}

// ---------------------------------------------------------------- Groq (Whisper, plan gratuito)

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
}

interface WhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
}

/** Frases que Whisper suele inventar sobre silencio o ruido. */
const HALLUCINATIONS = [
  /subt[ií]tulos (realizados|creados|hechos) por/i,
  /amara\.org/i,
  /^¡?gracias por (ver|mirar)( el v[ií]deo)?[.!]*$/i,
  /^suscr[ií]bete/i,
  /^thanks? (you )?for watching[.!]*$/i,
  /^subtitles by/i,
];

/**
 * Descarta segmentos que casi seguro no son voz: Whisper transcribe ruido o silencio como
 * frases de vídeos de YouTube. Mismos criterios que usa Whisper (no_speech_prob, avg_logprob,
 * compression_ratio) más una lista de frases típicas.
 */
export function filterWhisperSegments(segs: WhisperSegment[]): RawSegment[] {
  return segs
    .filter((s) => {
      const text = (s.text ?? "").trim();
      if (!text) return false;
      const noSpeech = s.no_speech_prob ?? 0;
      const logprob = s.avg_logprob ?? 0;
      if (noSpeech > 0.6 && logprob < -1) return false;
      if ((s.compression_ratio ?? 0) > 2.4) return false;
      if (noSpeech > 0.3 && HALLUCINATIONS.some((re) => re.test(text))) return false;
      return true;
    })
    .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
}

async function transcribeGroq(audio: Buffer, language: TranscriptionLanguage, filename: string): Promise<TrackResult> {
  const key = env.groqKey();
  if (!key) throw new TranscriptionError("Falta GROQ_API_KEY");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/webm" }), filename);
  form.append("model", env.groqModel());
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  if (language !== "multi") form.append("language", language);

  const res = await fetch(`${env.groqUrl()}/openai/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after")) || 60;
    throw new TranscriptionError(
      `Se alcanzó el límite gratuito de Groq. Pulsa «Reintentar» dentro de ${Math.ceil(retry / 60)} min (lo ya transcrito se conserva).`,
      retry,
    );
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new TranscriptionError(`Groq respondió ${res.status}: ${body}`);
  }
  const data = (await res.json()) as WhisperResponse;
  const segments = data.segments
    ? filterWhisperSegments(data.segments)
    : data.text?.trim()
      ? [{ start: 0, end: data.duration ?? 0, text: data.text.trim() }]
      : [];
  return { segments, durationSec: Math.round(data.duration ?? 0), language: data.language ?? null };
}

// ---------------------------------------------------------------- Deepgram (de pago, separa hablantes)

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

function deepgramQuery(model: string, language: TranscriptionLanguage, diarize: boolean): URLSearchParams {
  const p = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    diarize: String(diarize),
    utterances: "true",
    paragraphs: "false",
  });
  if (language === "multi") {
    if (model.startsWith("nova-3")) p.set("language", "multi");
    else p.set("detect_language", "true");
  } else {
    p.set("language", language);
  }
  return p;
}

export function parseDeepgram(data: DeepgramResponse, fallbackLanguage: string | null, diarize = true): TrackResult {
  const segments: RawSegment[] = (data.results?.utterances ?? []).map((u) => ({
    start: u.start,
    end: u.end,
    text: u.transcript ?? "",
    speaker: diarize ? (typeof u.speaker === "number" ? u.speaker : 0) : undefined,
  }));
  const ch = data.results?.channels?.[0];
  if (segments.length === 0) {
    const text = ch?.alternatives?.[0]?.transcript?.trim();
    if (text) segments.push({ start: 0, end: data.metadata?.duration ?? 0, text, speaker: diarize ? 0 : undefined });
  }
  const language = ch?.detected_language ?? ch?.alternatives?.[0]?.languages?.[0] ?? fallbackLanguage;
  return { segments, durationSec: Math.round(data.metadata?.duration ?? 0), language };
}

async function callDeepgram(audio: Buffer, model: string, language: TranscriptionLanguage, diarize: boolean) {
  const key = env.deepgramKey();
  if (!key) throw new TranscriptionError("Falta DEEPGRAM_API_KEY");
  return fetch(`${env.deepgramUrl()}/v1/listen?${deepgramQuery(model, language, diarize)}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "audio/webm" },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(240_000),
  });
}

async function transcribeDeepgram(audio: Buffer, language: TranscriptionLanguage, diarize: boolean): Promise<TrackResult> {
  const primary = env.deepgramModel();
  let res = await callDeepgram(audio, primary, language, diarize);
  if (res.status === 400 && primary !== "nova-2") res = await callDeepgram(audio, "nova-2", language, diarize);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new TranscriptionError(`Deepgram respondió ${res.status}: ${body}`);
  }
  return parseDeepgram((await res.json()) as DeepgramResponse, language === "multi" ? null : language, diarize);
}

// ---------------------------------------------------------------- entrada única

export function currentProvider(): Provider {
  const p = env.transcriptionProvider();
  if (!p) throw new TranscriptionError("Falta configurar la transcripción: añade GROQ_API_KEY (gratis) o DEEPGRAM_API_KEY.");
  return p;
}

/** Transcribe el audio de una pista. En la pista del micrófono no se separan hablantes: es solo tu voz. */
export async function transcribeTrack(
  audio: Buffer,
  track: Track,
  language: TranscriptionLanguage,
  filename: string,
): Promise<TrackResult> {
  const provider = currentProvider();
  if (provider === "groq") return transcribeGroq(audio, language, filename);
  return transcribeDeepgram(audio, language, track !== "mic");
}
