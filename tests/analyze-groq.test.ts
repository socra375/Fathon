import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeWithGroq, estimateTokens, parseResetHeader, splitTranscript } from "@/lib/analyze-groq";
import { emptyAnalysis, type Analysis, type AnalyzeInput } from "@/lib/analyze";
import { Budget, ContinueLater } from "@/lib/budget";

const input = (transcriptText: string): AnalyzeInput => ({
  transcriptText,
  platform: "Google Meet",
  title: "Demo",
  startedAt: new Date("2026-10-31T10:00:00Z"),
  durationSec: 600,
  talk: [{ speaker: 0, label: "Tú", seconds: 600, pct: 100, turns: 3, words: 100 }],
  reportLanguage: "es",
});

const analysis = (title: string): Analysis => ({ ...emptyAnalysis("es"), title, summary: `Resumen ${title}` });

function ok(body: Analysis, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("helpers", () => {
  it("parses Groq reset headers", () => {
    expect(parseResetHeader("7.66s")).toBe(7660);
    expect(parseResetHeader("1m2.5s")).toBe(62500);
    expect(parseResetHeader("350ms")).toBe(350);
    expect(parseResetHeader(null)).toBe(0);
  });

  it("splits a transcript by lines within the token budget", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `[00:0${i}] Tú: ${"palabra ".repeat(10)}`);
    const chunks = splitTranscript(lines.join("\n"), 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(60 + 40);
  });
});

describe("analyzeWithGroq", () => {
  const calls: { body: Record<string, unknown> }[] = [];
  let responses: (() => Response)[] = [];

  beforeEach(() => {
    process.env.GROQ_API_KEY = "g";
    process.env.GROQ_API_URL = "http://groq.test";
    calls.length = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      const next = responses.shift();
      if (!next) throw new Error("respuesta no prevista");
      return next();
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANALYSIS_CHUNK_TOKENS;
  });

  it("analyzes a short meeting in a single structured call", async () => {
    responses = [() => ok(analysis("Corta"))];
    const save = vi.fn();
    const out = await analyzeWithGroq(input("[00:01] Tú: Hola"), Budget.fromNow(60_000), { parts: [], save });
    expect(out.title).toBe("Corta");
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { model: string; response_format: { type: string } };
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format.type).toBe("json_schema");
    expect(save).not.toHaveBeenCalled();
  });

  it("map-reduces long meetings and saves each part", async () => {
    process.env.ANALYSIS_CHUNK_TOKENS = "40";
    const text = Array.from({ length: 6 }, (_, i) => `[00:0${i}] Tú: frase número ${i} con algo de contenido`).join("\n");
    const n = splitTranscript(text, 40).length;
    expect(n).toBeGreaterThan(1);
    responses = [...Array.from({ length: n }, (_, i) => () => ok(analysis(`P${i}`))), () => ok(analysis("Final"))];
    const saves: (Analysis | null)[][] = [];
    // ANALYSIS_CHUNK_TOKENS también limita la combinación: con 40 tokens agrupa por niveles.
    responses.push(...Array.from({ length: 20 }, () => () => ok(analysis("Final"))));
    const out = await analyzeWithGroq(input(text), Budget.fromNow(60_000), {
      parts: [],
      save: async (p) => {
        saves.push([...p]);
      },
    });
    expect(out.title).toBe("Final");
    expect(saves).toHaveLength(n);
    expect(saves.at(-1)!.every(Boolean)).toBe(true);
    const userMsgs = calls.map((c) => (c.body as { messages: { content: string }[] }).messages[1].content);
    expect(userMsgs[0]).toContain(`PARTE 1 de ${n}`);
    expect(userMsgs.at(-1)).toContain("informe final de toda la reunión");
  });

  it("resumes from saved parts", async () => {
    process.env.ANALYSIS_CHUNK_TOKENS = "40";
    const text = Array.from({ length: 6 }, (_, i) => `[00:0${i}] Tú: frase número ${i} con algo de contenido`).join("\n");
    const n = splitTranscript(text, 40).length;
    const saved = Array.from({ length: n }, (_, i) => analysis(`P${i}`));
    responses = Array.from({ length: 20 }, () => () => ok(analysis("Final")));
    const out = await analyzeWithGroq(input(text), Budget.fromNow(60_000), { parts: saved, save: vi.fn() });
    expect(out.title).toBe("Final");
    for (const c of calls) expect((c.body as { messages: { content: string }[] }).messages[1].content).not.toContain("PARTE");
  });

  it("waits on 429 and retries", async () => {
    responses = [
      () => new Response("{}", { status: 429, headers: { "retry-after": "0" , "x-ratelimit-reset-tokens": "50ms" } }),
      () => ok(analysis("Tras esperar")),
    ];
    const out = await analyzeWithGroq(input("[00:01] Tú: Hola"), Budget.fromNow(60_000), { parts: [], save: vi.fn() });
    expect(out.title).toBe("Tras esperar");
    expect(calls).toHaveLength(2);
  });

  it("falls back to plain JSON when the model rejects json_schema", async () => {
    responses = [
      () => new Response(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }), { status: 400 }),
      () => ok(analysis("JSON simple")),
    ];
    const out = await analyzeWithGroq(input("[00:01] Tú: Hola"), Budget.fromNow(60_000), { parts: [], save: vi.fn() });
    expect(out.title).toBe("JSON simple");
    expect((calls[1].body as { response_format: { type: string } }).response_format.type).toBe("json_object");
  });

  it("asks to continue later when the rate-limit wait does not fit the budget", async () => {
    process.env.ANALYSIS_CHUNK_TOKENS = "40";
    const text = Array.from({ length: 6 }, (_, i) => `[00:0${i}] Tú: frase número ${i} con algo de contenido`).join("\n");
    responses = [
      () => ok(analysis("P0"), { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "59s" }),
    ];
    const save = vi.fn(async () => {});
    await expect(analyzeWithGroq(input(text), Budget.fromNow(5_000), { parts: [], save })).rejects.toBeInstanceOf(ContinueLater);
    expect(save).toHaveBeenCalledTimes(1); // el primer tramo quedó guardado
  });
});

describe("Budget", () => {
  it("never stops before making progress", () => {
    const b = new Budget(Date.now() - 1);
    expect(() => b.ensure(1000)).not.toThrow();
    b.markProgress();
    expect(() => b.ensure(1000)).toThrow(ContinueLater);
  });
});
