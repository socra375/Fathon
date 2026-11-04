/**
 * Proveedores de IA para el análisis de la transcripción.
 *
 * Cada proveedor recibe (system, user) y devuelve el texto de la respuesta, que debe ser JSON.
 * Los errores de límite se convierten en `ProviderLimit` para que el rotador pase al siguiente.
 *
 *  - claude      De pago, la mejor calidad. Solo se usa si hay ANTHROPIC_API_KEY.
 *  - gemini      Gratis (Google AI Studio). Ventana de 1 M de tokens: analiza la reunión de una vez.
 *  - openrouter  Gratis con «openrouter/free» (20 peticiones/min y 50/día; 1.000/día con 10 USD de saldo).
 *  - groq        Gratis, pero con ~8.000 tokens por minuto: obliga a dividir la transcripción.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env, type LlmId } from "./env";
import { extractJson } from "./json";
import { classifyHttpError, ProviderLimit } from "./rotator";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** JSON Schema de la respuesta (salida estructurada cuando el proveedor la admite). */
  schema: Record<string, unknown>;
}

export interface LlmProvider {
  id: LlmId;
  label: string;
  /** Tokens de entrada que admite una sola petición. */
  maxInputTokens: number;
  complete(req: LlmRequest): Promise<string>;
}

/** Estimación prudente para texto en español (≈ 3 caracteres por token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export const JSON_HINT =
  "Responde solo con un objeto JSON válido, sin texto antes ni después ni bloques de código, con exactamente estas claves: title, summary, key_points, topics[{title,start,summary}], decisions, action_items[{owner,task,due}], open_questions, risks, speakers[{label,likely_name,contribution}], sentiment{overall: positive|neutral|negative|mixed, explanation}, follow_up_email{subject,body}.";

// ---------------------------------------------------------------- compatibles con OpenAI

interface ChatOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  req: LlmRequest;
  maxTokens: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  schemaName?: string;
}

/** POST /chat/completions con salida estructurada si se admite; si no, JSON simple; si no, texto. */
export async function chat(o: ChatOptions): Promise<string> {
  const modes = ["json_schema", "json_object", "none"] as const;
  let lastBadRequest = "";

  for (const mode of modes) {
    const body: Record<string, unknown> = {
      model: o.model,
      messages: [
        { role: "system", content: `${o.req.system}\n\n${JSON_HINT}` },
        { role: "user", content: o.req.user },
      ],
      temperature: 0.2,
      [o.maxTokensField ?? "max_tokens"]: o.maxTokens,
      ...o.extraBody,
    };
    if (mode === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: o.schemaName ?? "informe_reunion", strict: true, schema: o.req.schema } };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }

    let res: Response;
    try {
      res = await fetch(`${o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", ...o.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(150_000),
      });
    } catch (err) {
      throw new ProviderLimit(`${o.provider}: sin respuesta (${err instanceof Error ? err.message : err})`, o.provider, 120_000, "overload");
    }

    if (res.status === 400 && mode !== "none") {
      lastBadRequest = (await res.text()).slice(0, 200); // este modelo no admite ese formato: probar el siguiente
      continue;
    }
    if (!res.ok) throw classifyHttpError(o.provider, res.status, res.headers, await res.text());

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      error?: { message?: string; code?: number | string };
    };
    // OpenRouter devuelve a veces 200 con un error dentro del cuerpo.
    if (data.error) {
      throw classifyHttpError(o.provider, Number(data.error.code) || 502, res.headers, JSON.stringify(data.error));
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error(`${o.provider}: la respuesta superó el límite de longitud`);
    const content = choice?.message?.content;
    if (!content || !content.trim()) throw new Error(`${o.provider}: respuesta vacía`);
    return extractJson(content);
  }
  throw new Error(`${o.provider}: el modelo rechazó la petición (${lastBadRequest})`);
}

// ---------------------------------------------------------------- proveedores

function groqProvider(): LlmProvider | null {
  const key = env.groqKey();
  if (!key) return null;
  return {
    id: "groq",
    label: "Groq",
    maxInputTokens: env.maxInputTokens("groq"),
    complete: (req) => {
      const model = env.groqAnalysisModel();
      return chat({
        provider: "groq",
        baseUrl: `${env.groqUrl()}/openai/v1`,
        apiKey: key,
        model,
        req,
        maxTokens: req.maxTokens,
        maxTokensField: "max_completion_tokens",
        extraBody: model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {},
      });
    },
  };
}

function geminiProvider(): LlmProvider | null {
  const key = env.geminiKey();
  if (!key) return null;
  return {
    id: "gemini",
    label: "Gemini",
    maxInputTokens: env.maxInputTokens("gemini"),
    // Gemini 2.5 "piensa" antes de responder y esos tokens cuentan en el límite de salida.
    complete: (req) =>
      chat({
        provider: "gemini",
        baseUrl: `${env.geminiUrl()}/v1beta/openai`,
        apiKey: key,
        model: env.geminiModel(),
        req,
        maxTokens: Math.max(req.maxTokens, 8192),
      }),
  };
}

function openrouterProvider(): LlmProvider | null {
  const key = env.openrouterKey();
  if (!key) return null;
  return {
    id: "openrouter",
    label: "OpenRouter",
    maxInputTokens: env.maxInputTokens("openrouter"),
    complete: (req) =>
      chat({
        provider: "openrouter",
        baseUrl: env.openrouterUrl(),
        apiKey: key,
        model: env.openrouterModel(),
        req,
        maxTokens: Math.max(req.maxTokens, 4096),
        headers: { "HTTP-Referer": env.appUrl() ?? "https://minuta.local", "X-Title": "Minuta" },
      }),
  };
}

function claudeProvider(): LlmProvider | null {
  const apiKey = env.anthropicKey();
  if (!apiKey) return null;
  return {
    id: "claude",
    label: "Claude",
    maxInputTokens: env.maxInputTokens("claude"),
    complete: async (req) => {
      const client = new Anthropic({ apiKey, timeout: 280_000, maxRetries: 1 });
      try {
        // Streaming: la respuesta puede ser larga. `fallbacks: "default"` reintenta en el servidor con
        // otro modelo si el principal rechaza la petición por política.
        const stream = client.beta.messages.stream({
          model: env.anthropicModel(),
          max_tokens: Math.max(req.maxTokens, 16_000),
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") throw new Error("claude: rechazó analizar esta reunión");
        if (message.stop_reason === "max_tokens") throw new Error("claude: la respuesta superó el límite de longitud");
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        return extractJson(text);
      } catch (err) {
        if (err instanceof Anthropic.APIError && typeof err.status === "number") {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(err.headers ?? {})) if (typeof v === "string") headers[k.toLowerCase()] = v;
          throw classifyHttpError("claude", err.status, headers, JSON.stringify(err.error ?? err.message));
        }
        if (err instanceof Anthropic.APIConnectionError) {
          throw new ProviderLimit(`claude: sin conexión (${err.message})`, "claude", 120_000, "overload");
        }
        throw err;
      }
    },
  };
}

const BUILDERS: Record<LlmId, () => LlmProvider | null> = {
  claude: claudeProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  groq: groqProvider,
};

/** Los proveedores de análisis con clave, en el orden configurado. */
export function llmProviders(): LlmProvider[] {
  const out: LlmProvider[] = [];
  for (const id of env.analysisOrder()) {
    const p = BUILDERS[id]?.();
    if (p && !out.some((x) => x.id === p.id)) out.push(p);
  }
  return out;
}
