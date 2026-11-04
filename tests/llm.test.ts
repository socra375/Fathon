import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat, llmProviders } from "@/lib/llm";
import { extractJson } from "@/lib/json";
import { ProviderLimit } from "@/lib/rotator";

const req = { system: "sistema", user: "usuario", maxTokens: 1000, schema: { type: "object", properties: {}, additionalProperties: false } };
const base = { provider: "test", baseUrl: "http://llm.test/v1", apiKey: "k", model: "m", req, maxTokens: 1000 };

const reply = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop", ...extra }] }), { status: 200 });

describe("extractJson", () => {
  it("quita las vallas de código y el texto que rodea al JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Aquí tienes: {"a":1} ¡listo!')).toBe('{"a":1}');
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("chat (APIs compatibles con OpenAI)", () => {
  const bodies: Record<string, unknown>[] = [];
  let responses: (() => Response | Promise<Response>)[] = [];
  beforeEach(() => {
    bodies.length = 0;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const next = responses.shift();
      if (!next) throw new Error("respuesta no prevista");
      return next();
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pide salida estructurada y añade la pista de JSON al sistema", async () => {
    responses = [() => reply('{"ok":true}')];
    expect(await chat(base)).toBe('{"ok":true}');
    const b = bodies[0] as { response_format: { type: string; json_schema: { strict: boolean } }; messages: { content: string }[] };
    expect(b.response_format.type).toBe("json_schema");
    expect(b.response_format.json_schema.strict).toBe(true);
    expect(b.messages[0].content).toContain("sistema");
    expect(b.messages[0].content).toContain("objeto JSON válido");
  });

  it("si el modelo no admite json_schema (400) prueba JSON simple y luego texto", async () => {
    responses = [() => new Response("response_format json_schema no soportado", { status: 400 }), () => new Response("json_object no soportado", { status: 400 }), () => reply('```json\n{"ok":1}\n```')];
    expect(await chat(base)).toBe('{"ok":1}');
    expect(bodies.map((b) => (b.response_format as { type?: string } | undefined)?.type)).toEqual(["json_schema", "json_object", undefined]);
  });

  it("un 429 se convierte en una pausa del proveedor con la espera que indica", async () => {
    responses = [() => new Response("rate limited", { status: 429, headers: { "retry-after": "42" } })];
    const err = await chat(base).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderLimit);
    expect(err.retryAfterMs).toBe(42_000);
  });

  it("OpenRouter a veces devuelve un error dentro de un 200", async () => {
    responses = [() => new Response(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day" } }), { status: 200 })];
    const err = await chat(base).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderLimit);
  });

  it("detecta respuestas cortadas y vacías", async () => {
    responses = [() => reply('{"a":', { finish_reason: "length" })];
    await expect(chat(base)).rejects.toThrow(/límite de longitud/);
    responses = [() => reply("   ")];
    await expect(chat(base)).rejects.toThrow(/vacía/);
  });

  it("un fallo de red se trata como proveedor no disponible, no como error de la reunión", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = await chat(base).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderLimit);
    expect(err.kind).toBe("overload");
  });
});

describe("llmProviders", () => {
  const keys = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "ANALYSIS_PROVIDERS", "ANALYSIS_PROVIDER"];
  beforeEach(() => keys.forEach((k) => delete process.env[k]));

  it("solo incluye los que tienen clave, con Claude primero y luego los gratuitos", () => {
    process.env.GROQ_API_KEY = "g";
    process.env.GEMINI_API_KEY = "m";
    process.env.OPENROUTER_API_KEY = "o";
    expect(llmProviders().map((p) => p.id)).toEqual(["gemini", "openrouter", "groq"]);
    process.env.ANTHROPIC_API_KEY = "c";
    expect(llmProviders().map((p) => p.id)).toEqual(["claude", "gemini", "openrouter", "groq"]);
  });

  it("respeta el orden elegido y ANALYSIS_PROVIDER como primero", () => {
    process.env.GROQ_API_KEY = "g";
    process.env.GEMINI_API_KEY = "m";
    process.env.ANALYSIS_PROVIDERS = "groq,gemini";
    expect(llmProviders().map((p) => p.id)).toEqual(["groq", "gemini"]);
    delete process.env.ANALYSIS_PROVIDERS;
    process.env.ANALYSIS_PROVIDER = "groq";
    expect(llmProviders().map((p) => p.id)).toEqual(["groq", "gemini"]);
  });

  it("acepta GOOGLE_API_KEY para Gemini", () => {
    process.env.GOOGLE_API_KEY = "x";
    expect(llmProviders().map((p) => p.id)).toEqual(["gemini"]);
  });
});
