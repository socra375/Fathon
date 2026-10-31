import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "./env";
import { clock, type TalkShare } from "./format";
import type { ReportLanguage } from "./settings";

/** Estructura del análisis que devuelve la IA (validada con zod después de la llamada). */
export const AnalysisSchema = z.object({
  title: z.string(),
  summary: z.string(),
  key_points: z.array(z.string()),
  topics: z.array(z.object({ title: z.string(), start: z.string(), summary: z.string() })),
  decisions: z.array(z.string()),
  action_items: z.array(z.object({ owner: z.string(), task: z.string(), due: z.string() })),
  open_questions: z.array(z.string()),
  risks: z.array(z.string()),
  speakers: z.array(z.object({ label: z.string(), likely_name: z.string(), contribution: z.string() })),
  sentiment: z.object({
    overall: z.enum(["positive", "neutral", "negative", "mixed"]),
    explanation: z.string(),
  }),
  follow_up_email: z.object({ subject: z.string(), body: z.string() }),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** JSON Schema equivalente para `output_config.format` (salida estructurada garantizada). */
export const ANALYSIS_JSON_SCHEMA = obj({
  title: str,
  summary: str,
  key_points: strArr,
  topics: { type: "array", items: obj({ title: str, start: str, summary: str }) },
  decisions: strArr,
  action_items: { type: "array", items: obj({ owner: str, task: str, due: str }) },
  open_questions: strArr,
  risks: strArr,
  speakers: { type: "array", items: obj({ label: str, likely_name: str, contribution: str }) },
  sentiment: obj({ overall: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] }, explanation: str }),
  follow_up_email: obj({ subject: str, body: str }),
});

export const SYSTEM_ES = `Eres el analista de reuniones de Minuta. Recibes la transcripción automática de una reunión (con marcas de tiempo y etiquetas de hablante, que puede contener errores de reconocimiento) y produces un informe útil para la persona que grabó la reunión y necesita actuar después.

Etiquetas de hablante:
- "Tú" es la persona que grabó la reunión (su micrófono).
- "Otros participantes" agrupa a todas las demás personas en una sola etiqueta: no las distingue entre sí. Si por el contexto se deduce quién habla (alguien dice su nombre, se presenta o le responden por su nombre), úsalo en el informe.
- "Participante N" o "Hablante N" son personas distintas detectadas automáticamente.

Reglas:
- Escribe todo el informe en español, aunque la reunión sea en otro idioma.
- Básate solo en lo que se dijo. No inventes nombres, fechas, cifras ni acuerdos. Si algo es ambiguo, dilo.
- "summary": 3 a 5 frases que respondan qué se trató, qué se decidió y qué sigue.
- "title": título breve y específico (máx. 70 caracteres).
- "topics": temas en orden cronológico; "start" es la marca de tiempo (mm:ss o h:mm:ss) en que empieza el tema.
- "decisions": solo acuerdos explícitos. Lista vacía si no los hubo.
- "action_items": tareas concretas. "owner" es el nombre si se menciona, si no la etiqueta del hablante, o "Sin asignar". "due" es la fecha o plazo mencionado, o "" si no se dijo.
- "speakers": una entrada por cada etiqueta de hablante de la transcripción, con "label" exactamente igual a la etiqueta. "likely_name" solo si se deduce claramente de la conversación (p. ej. alguien le llama por su nombre); si no, "". Para "Tú" y "Otros participantes" deja "likely_name" vacío, salvo que "Tú" se presente con su nombre.
- "risks": objeciones, bloqueos, riesgos o desacuerdos detectados.
- "follow_up_email": correo de seguimiento listo para enviar a los participantes, en tono profesional y cercano, con resumen, acuerdos y próximos pasos.
- Si la transcripción es muy corta o no tiene contenido útil, dilo en "summary" y deja las listas vacías.`;

export const SYSTEM_EN = SYSTEM_ES.replace("Escribe todo el informe en español, aunque la reunión sea en otro idioma.", "Write the entire report in English, even if the meeting was in another language.");

export interface AnalyzeInput {
  transcriptText: string;
  platform: string;
  title: string;
  startedAt: Date;
  durationSec: number;
  talk: TalkShare[];
  reportLanguage: ReportLanguage;
}

export class AnalysisError extends Error {}

export function systemPrompt(lang: ReportLanguage): string {
  return lang === "en" ? SYSTEM_EN : SYSTEM_ES;
}

/** Cabecera con los datos de la reunión (se repite en cada tramo del análisis gratuito). */
export function meetingHeader(input: AnalyzeInput): string {
  const talk = input.talk
    .map((t) => `- ${t.label}: ${t.pct}% del tiempo de palabra (${t.turns} intervenciones)`)
    .join("\n");
  return [
    "<reunion>",
    `Plataforma: ${input.platform}`,
    `Título de la pestaña: ${input.title || "(sin título)"}`,
    `Fecha: ${input.startedAt.toISOString()}`,
    `Duración: ${clock(input.durationSec)}`,
    "Tiempo de palabra medido:",
    talk || "- (sin datos)",
    "</reunion>",
  ].join("\n");
}

/** Parsea y valida la salida JSON de un modelo. */
export function parseAnalysis(text: string): Analysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AnalysisError("La IA devolvió un JSON no válido.");
  }
  const result = AnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new AnalysisError(`El análisis no cumple el esquema: ${result.error.issues[0]?.message ?? ""}`);
  }
  return result.data;
}

export function buildPrompt(input: AnalyzeInput): string {
  return [
    meetingHeader(input),
    "",
    "<transcripcion>",
    input.transcriptText,
    "</transcripcion>",
    "",
    "Genera el informe de la reunión siguiendo el esquema.",
  ].join("\n");
}

/** Análisis con Claude (de pago): una sola llamada con toda la transcripción. */
export async function analyzeWithClaude(input: AnalyzeInput): Promise<Analysis> {
  const apiKey = env.anthropicKey();
  if (!apiKey) throw new AnalysisError("Falta ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey, timeout: 280_000, maxRetries: 2 });

  // Streaming: la transcripción puede ser larga. `fallbacks: "default"` reintenta en el
  // servidor con otro modelo si el principal rechaza la petición por política.
  const stream = client.beta.messages.stream({
    model: env.anthropicModel(),
    max_tokens: 32_000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: ANALYSIS_JSON_SCHEMA },
    },
    system: systemPrompt(input.reportLanguage),
    messages: [{ role: "user", content: buildPrompt(input) }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new AnalysisError("La IA rechazó analizar esta reunión.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new AnalysisError("El análisis superó el límite de longitud.");
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseAnalysis(text);
}

/** Informe mínimo cuando no se detectó voz (no se gasta una llamada a la IA). */
export function emptyAnalysis(lang: ReportLanguage): Analysis {
  const es = lang === "es";
  return {
    title: es ? "Reunión sin voz detectada" : "Meeting with no speech detected",
    summary: es
      ? "No se detectó conversación en la grabación. Comprueba que marcaste «Compartir audio de la pestaña» al iniciar la grabación."
      : "No conversation was detected in the recording. Make sure “Share tab audio” was checked when recording started.",
    key_points: [],
    topics: [],
    decisions: [],
    action_items: [],
    open_questions: [],
    risks: [],
    speakers: [],
    sentiment: { overall: "neutral", explanation: "" },
    follow_up_email: { subject: "", body: "" },
  };
}
