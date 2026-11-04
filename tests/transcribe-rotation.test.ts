import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryLater } from "@/lib/budget";
import { memoryStore } from "@/lib/rotator";
import { sttProviders, transcribeTrack } from "@/lib/transcribe";

const audio = Buffer.from("fake-webm");

const groqOk = () =>
  new Response(JSON.stringify({ language: "spanish", duration: 12, segments: [{ start: 0, end: 4, text: " Hola a todos", avg_logprob: -0.2, no_speech_prob: 0.01 }] }), { status: 200 });
const deepgramOk = () =>
  new Response(
    JSON.stringify({
      metadata: { duration: 12 },
      results: { channels: [{ detected_language: "es", alternatives: [{ transcript: "Hola" }] }], utterances: [{ start: 0, end: 4, speaker: 1, transcript: "Hola a todos" }] },
    }),
    { status: 200 },
  );

let hits: string[];
let groq: () => Response;
let deepgram: () => Response;

beforeEach(() => {
  hits = [];
  process.env.GROQ_API_KEY = "g";
  process.env.GROQ_API_URL = "http://groq.test";
  process.env.DEEPGRAM_API_KEY = "d";
  process.env.DEEPGRAM_API_URL = "http://deepgram.test";
  delete process.env.TRANSCRIPTION_PROVIDERS;
  delete process.env.TRANSCRIPTION_PROVIDER;
  groq = groqOk;
  deepgram = deepgramOk;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("http://groq.test")) {
      hits.push("groq");
      return groq();
    }
    hits.push("deepgram");
    return deepgram();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("transcripción con rotación", () => {
  it("usa Groq primero (gratis) y Deepgram solo si Groq se agota", async () => {
    expect(sttProviders().map((p) => p.id)).toEqual(["groq", "deepgram"]);
    const r = await transcribeTrack(audio, "tab", "multi", "tab-0.webm", { store: memoryStore() });
    expect(hits).toEqual(["groq"]);
    expect(r.segments[0].text).toBe("Hola a todos");
  });

  it("cuando Groq alcanza el límite por hora, pasa a Deepgram y las siguientes pistas ni prueban Groq", async () => {
    groq = () => new Response("Rate limit reached for audio seconds per hour", { status: 429, headers: { "retry-after": "360" } });
    const store = memoryStore();
    const r1 = await transcribeTrack(audio, "tab", "multi", "tab-0.webm", { store });
    expect(hits).toEqual(["groq", "deepgram"]);
    expect(r1.segments[0].speaker).toBe(1); // Deepgram separa hablantes en la pista de los demás

    hits.length = 0;
    await transcribeTrack(audio, "mic", "multi", "mic-0.webm", { store });
    expect(hits).toEqual(["deepgram"]);
  });

  it("solo con Groq y en pausa, pide continuar más tarde en lugar de fallar", async () => {
    delete process.env.DEEPGRAM_API_KEY;
    groq = () => new Response("limit", { status: 429, headers: { "retry-after": "360" } });
    const err = await transcribeTrack(audio, "tab", "multi", "tab-0.webm", { store: memoryStore() }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryLater);
    expect(Math.round(((err as RetryLater).at.getTime() - Date.now()) / 1000)).toBeGreaterThan(300);
  });

  it("explica qué configurar si no hay ninguna clave", async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    await expect(transcribeTrack(audio, "tab", "multi", "t.webm", { store: memoryStore() })).rejects.toThrow(/GROQ_API_KEY/);
  });

  it("respeta el orden configurado", async () => {
    process.env.TRANSCRIPTION_PROVIDERS = "deepgram,groq";
    expect(sttProviders().map((p) => p.id)).toEqual(["deepgram", "groq"]);
    await transcribeTrack(audio, "tab", "multi", "t.webm", { store: memoryStore() });
    expect(hits).toEqual(["deepgram"]);
  });
});
