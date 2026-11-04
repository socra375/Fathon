import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAnalysis, type Analysis, type AnalyzeInput } from "@/lib/analyze";
import { analyzeRotating, splitTranscript } from "@/lib/analyze-rotating";
import { Budget, RetryLater } from "@/lib/budget";
import { estimateTokens, type LlmProvider, type LlmRequest } from "@/lib/llm";
import { memoryStore, ProviderLimit } from "@/lib/rotator";

const analysis = (title: string): Analysis => ({ ...emptyAnalysis("es"), title, summary: `Resumen ${title}` });

const input = (transcriptText: string): AnalyzeInput => ({
  transcriptText,
  platform: "Google Meet",
  title: "Demo",
  startedAt: new Date("2026-11-04T10:00:00Z"),
  durationSec: 600,
  talk: [{ speaker: 0, label: "Tú", seconds: 600, pct: 100, turns: 3, words: 100 }],
  reportLanguage: "es",
});

/** Un proveedor falso que registra cuántas veces se le llamó y responde con lo que se le diga. */
function fake(
  id: LlmProvider["id"],
  maxInputTokens: number,
  reply: (req: LlmRequest, call: number) => string | Promise<string>,
): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    id,
    label: id,
    maxInputTokens,
    calls,
    complete: async (req) => {
      calls.push(req);
      return reply(req, calls.length);
    },
  };
}

const json = (a: Analysis) => JSON.stringify(a);
const long = Array.from({ length: 400 }, (_, i) => `[${String(i).padStart(2, "0")}:00] Tú: frase número ${i} con bastante contenido para ocupar espacio`).join("\n");

let saved: (Analysis | null)[][];
const progress = (parts: (Analysis | null)[] = []) => ({
  parts,
  save: async (p: (Analysis | null)[]) => {
    saved.push([...p]);
  },
});
const ctx = (providers: LlmProvider[], over: Partial<Parameters<typeof analyzeRotating>[1]> = {}) => ({
  budget: Budget.fromNow(60_000),
  progress: progress(),
  store: memoryStore(),
  providers,
  ...over,
});

beforeEach(() => {
  saved = [];
  process.env.ANALYSIS_CHUNK_TOKENS = "800";
});

describe("analyzeRotating", () => {
  it("analyzes a short meeting in one call with the first provider", async () => {
    const gem = fake("gemini", 800_000, () => json(analysis("Gemini")));
    const groq = fake("groq", 5800, () => json(analysis("Groq")));
    const out = await analyzeRotating(input("[00:01] Tú: Hola"), ctx([gem, groq]));
    expect(out.title).toBe("Gemini");
    expect(gem.calls).toHaveLength(1);
    expect(groq.calls).toHaveLength(0);
    expect(gem.calls[0].schema).toBeTruthy();
  });

  it("sends a long meeting in one request only to providers whose window fits it", async () => {
    const need = estimateTokens(long);
    expect(need).toBeGreaterThan(5800);
    const gem = fake("gemini", 800_000, () => json(analysis("Gemini")));
    const groq = fake("groq", 5800, () => json(analysis("Groq")));
    const out = await analyzeRotating(input(long), ctx([groq, gem]));
    expect(out.title).toBe("Gemini");
    expect(groq.calls).toHaveLength(0);
  });

  it("falls over to the next provider when one reaches its limit, and remembers it", async () => {
    const store = memoryStore();
    const gem = fake("gemini", 800_000, () => {
      throw new ProviderLimit("cuota diaria", "gemini", 3_600_000, "quota");
    });
    const or = fake("openrouter", 24_000, () => json(analysis("OpenRouter")));
    const out = await analyzeRotating(input("[00:01] Tú: Hola"), ctx([gem, or], { store }));
    expect(out.title).toBe("OpenRouter");
    expect((await store.all()).has("analysis:gemini")).toBe(true);

    const again = await analyzeRotating(input("[00:01] Tú: Hola"), ctx([gem, or], { store }));
    expect(again.title).toBe("OpenRouter");
    expect(gem.calls).toHaveLength(1); // no se volvió a intentar
  });

  it("tries the next provider when the first returns invalid JSON", async () => {
    const bad = fake("gemini", 800_000, () => "esto no es JSON");
    const good = fake("openrouter", 24_000, () => "```json\n" + json(analysis("Bien")) + "\n```");
    const out = await analyzeRotating(input("[00:01] Tú: Hola"), ctx([bad, good]));
    expect(out.title).toBe("Bien");
  });

  it("splits into parts and combines them when only a small-window provider is available", async () => {
    const groq = fake("groq", 5800, (req) => {
      const part = /PARTE (\d+) de (\d+)/.exec(req.user);
      return json(analysis(part ? `P${part[1]}` : "Final"));
    });
    const out = await analyzeRotating(input(long), ctx([groq]));
    const n = splitTranscript(long, 800).length;
    expect(n).toBeGreaterThan(2);
    expect(out.title).toBe("Final");
    expect(saved).toHaveLength(n);
    expect(saved.at(-1)!.every(Boolean)).toBe(true);
    expect(groq.calls.at(-1)!.user).toContain("informe final de toda la reunión");
  });

  it("uses small providers for the parts when the big ones are paused", async () => {
    const store = memoryStore({ "analysis:gemini": { until: Date.now() + 3_600_000, reason: "cuota" } });
    const gem = fake("gemini", 800_000, () => json(analysis("Gemini")));
    const groq = fake("groq", 5800, (req) => json(analysis(/PARTE (\d+)/.exec(req.user) ? "Parte" : "Final")));
    const out = await analyzeRotating(input(long), ctx([gem, groq], { store }));
    expect(out.title).toBe("Final");
    expect(gem.calls).toHaveLength(0);
    expect(groq.calls.length).toBeGreaterThan(2);
  });

  it("resumes from saved parts without repeating them", async () => {
    const parts = splitTranscript(long, 800).map((_, i) => analysis(`P${i}`));
    const groq = fake("groq", 5800, () => json(analysis("Final")));
    const out = await analyzeRotating(input(long), ctx([groq], { progress: progress(parts) }));
    expect(out.title).toBe("Final");
    for (const c of groq.calls) expect(c.user).not.toContain("PARTE");
  });

  it("asks to retry later when every available provider is paused", async () => {
    const until = Date.now() + 3 * 3_600_000;
    const store = memoryStore({ "analysis:gemini": { until, reason: "cuota" } });
    const gem = fake("gemini", 800_000, () => json(analysis("Gemini")));
    const err = await analyzeRotating(input(long), ctx([gem], { store })).catch((e) => e);
    expect(err).toBeInstanceOf(RetryLater);
    expect((err as RetryLater).at.getTime()).toBe(until);
  });

  it("explains what to configure when there are no providers", async () => {
    await expect(analyzeRotating(input("hola"), ctx([]))).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("does not call a provider again after it succeeded once per request (one call per short meeting)", async () => {
    const spy = vi.fn(() => json(analysis("Uno")));
    const gem = fake("gemini", 800_000, spy);
    await analyzeRotating(input("[00:01] Tú: Hola"), ctx([gem]));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("tamaños reales", () => {
  it("con el tamaño de tramo por defecto, Groq (6k tokens) sigue admitiendo cada tramo", async () => {
    delete process.env.ANALYSIS_CHUNK_TOKENS;
    const base = Array.from({ length: 700 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}] Otros participantes: ${"palabra ".repeat(20)}${i}`).join("\n");
    expect(estimateTokens(base)).toBeGreaterThan(11_000);
    const groq = fake("groq", 5800, (req) => json(analysis(/PARTE/.test(req.user) ? "Parte" : "Final")));
    const out = await analyzeRotating(input(base), ctx([groq]));
    expect(out.title).toBe("Final");
    expect(groq.calls.length).toBeGreaterThanOrEqual(4);
  });
});
