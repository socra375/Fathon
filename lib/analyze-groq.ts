/**
 * Análisis gratuito con un modelo abierto en Groq (por defecto openai/gpt-oss-120b).
 *
 * El plan gratuito limita los tokens por minuto (~8.000), así que una transcripción larga no
 * cabe en una sola petición. Se hace en dos fases:
 *   1. Análisis de cada tramo de la transcripción (cada uno se guarda en cuanto termina).
 *   2. Combinación de los análisis parciales en el informe final.
 * Entre peticiones se respetan las cabeceras de límite de Groq; si hay que esperar más de lo
 * que queda de la invocación, se lanza `ContinueLater` y el proceso sigue en otra.
 */
import { ANALYSIS_JSON_SCHEMA, AnalysisError, meetingHeader, parseAnalysis, systemPrompt, type Analysis, type AnalyzeInput } from "./analyze";
import { Budget } from "./budget";
import { env } from "./env";

export interface GroqProgress {
  /** Análisis parciales ya hechos, por índice de tramo. */
  parts: (Analysis | null)[];
  save: (parts: (Analysis | null)[]) => Promise<void>;
}

/** Estimación conservadora de tokens para texto en español (≈ 3 caracteres por token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Divide la transcripción por líneas en tramos de como mucho `maxTokens`. */
export function splitTranscript(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const line of text.split("\n")) {
    const t = estimateTokens(line) + 1;
    if (cur.length && curTokens + t > maxTokens) {
      chunks.push(cur.join("\n"));
      cur = [];
      curTokens = 0;
    }
    cur.push(line);
    curTokens += t;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

/** "1m2.5s" | "7.66s" | "350ms" → milisegundos. */
export function parseResetHeader(v: string | null): number {
  if (!v) return 0;
  let ms = 0;
  for (const [, n, unit] of v.matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    const x = Number(n);
    ms += unit === "h" ? x * 3_600_000 : unit === "m" ? x * 60_000 : unit === "s" ? x * 1000 : x;
  }
  return Math.ceil(ms);
}

class RateGate {
  private remainingTokens = Number.POSITIVE_INFINITY;
  private resetAt = 0;

  update(res: Response): void {
    const rem = Number(res.headers.get("x-ratelimit-remaining-tokens"));
    if (Number.isFinite(rem)) {
      this.remainingTokens = rem;
      this.resetAt = Date.now() + parseResetHeader(res.headers.get("x-ratelimit-reset-tokens"));
    }
  }

  /** Tiempo a esperar para disponer de `needed` tokens. */
  waitFor(needed: number): number {
    if (needed <= this.remainingTokens) return 0;
    return Math.max(0, this.resetAt - Date.now()) + 250;
  }
}

const MAP_OUTPUT_TOKENS = 1800;
const REDUCE_OUTPUT_TOKENS = 3000;

async function callGroq(opts: {
  system: string;
  user: string;
  maxTokens: number;
  budget: Budget;
  gate: RateGate;
}): Promise<Analysis> {
  const key = env.groqKey();
  if (!key) throw new AnalysisError("Falta GROQ_API_KEY (o ANTHROPIC_API_KEY para usar Claude).");
  const needed = estimateTokens(opts.system + opts.user) + opts.maxTokens;
  let useSchema = true;

  for (let attempt = 0; attempt < 4; attempt++) {
    await opts.budget.wait(opts.gate.waitFor(needed));
    opts.budget.ensure(20_000);
    const res = await fetch(`${env.groqUrl()}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.groqAnalysisModel(),
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        temperature: 0.2,
        max_completion_tokens: opts.maxTokens,
        reasoning_effort: "low",
        response_format: useSchema
          ? { type: "json_schema", json_schema: { name: "informe_reunion", strict: true, schema: ANALYSIS_JSON_SCHEMA } }
          : { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    opts.gate.update(res);

    if (res.status === 429) {
      const retry = (Number(res.headers.get("retry-after")) || 0) * 1000 || parseResetHeader(res.headers.get("x-ratelimit-reset-tokens")) || 15_000;
      await opts.budget.wait(retry + 250);
      continue;
    }
    if (res.status === 400 && useSchema) {
      const body = await res.text();
      if (/response_format|json_schema|schema/i.test(body)) {
        useSchema = false; // el modelo no admite salida con esquema: JSON libre + validación
        continue;
      }
      throw new AnalysisError(`Groq respondió 400: ${body.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new AnalysisError(`Groq respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") throw new AnalysisError("El análisis superó el límite de longitud del modelo gratuito.");
    try {
      return parseAnalysis(choice?.message?.content ?? "");
    } catch (err) {
      if (attempt === 3) throw err;
      useSchema = false; // reintenta una vez pidiendo JSON simple
    }
  }
  throw new AnalysisError("No se pudo obtener el análisis del modelo gratuito.");
}

const JSON_HINT =
  "Responde solo con un objeto JSON con exactamente estas claves: title, summary, key_points, topics[{title,start,summary}], decisions, action_items[{owner,task,due}], open_questions, risks, speakers[{label,likely_name,contribution}], sentiment{overall: positive|neutral|negative|mixed, explanation}, follow_up_email{subject,body}.";

export async function analyzeWithGroq(input: AnalyzeInput, budget: Budget, progress: GroqProgress): Promise<Analysis> {
  const system = `${systemPrompt(input.reportLanguage)}\n\n${JSON_HINT}`;
  const header = meetingHeader(input);
  const gate = new RateGate();
  const chunks = splitTranscript(input.transcriptText, env.analysisChunkTokens());

  // Reunión corta: una sola petición.
  if (chunks.length === 1) {
    return callGroq({
      system,
      user: `${header}\n\n<transcripcion>\n${chunks[0]}\n</transcripcion>\n\nGenera el informe de la reunión siguiendo el esquema.`,
      maxTokens: REDUCE_OUTPUT_TOKENS,
      budget,
      gate,
    });
  }

  // 1. Un análisis por tramo (se guarda cada uno para poder continuar en otra invocación).
  const parts = chunks.map((_, i) => progress.parts[i] ?? null);
  for (let i = 0; i < chunks.length; i++) {
    if (parts[i]) continue;
    parts[i] = await callGroq({
      system,
      user: [
        header,
        "",
        `Esta es la PARTE ${i + 1} de ${chunks.length} de la transcripción. Analiza solo lo que aparece en esta parte;`,
        "otro paso combinará todas las partes. En «summary» resume solo esta parte y en «follow_up_email» deja subject y body vacíos.",
        "",
        "<transcripcion>",
        chunks[i],
        "</transcripcion>",
      ].join("\n"),
      maxTokens: MAP_OUTPUT_TOKENS,
      budget,
      gate,
    });
    await progress.save(parts);
    budget.markProgress();
  }

  // 2. Combinar. Si los parciales no caben en una petición, se combinan por grupos.
  let level = parts as Analysis[];
  const maxInput = env.analysisChunkTokens();
  while (estimateTokens(JSON.stringify(level)) > maxInput && level.length > 1) {
    const groups: Analysis[][] = [];
    let cur: Analysis[] = [];
    for (const p of level) {
      if (cur.length && estimateTokens(JSON.stringify([...cur, p])) > maxInput) {
        groups.push(cur);
        cur = [];
      }
      cur.push(p);
    }
    if (cur.length) groups.push(cur);
    if (groups.length === level.length) break; // cada parcial ya es grande: no se puede agrupar más
    const next: Analysis[] = [];
    for (const g of groups) next.push(g.length === 1 ? g[0] : await reduce(g, false));
    level = next;
  }
  return reduce(level, true);

  function reduce(group: Analysis[], final: boolean): Promise<Analysis> {
    return callGroq({
      system,
      user: [
        header,
        "",
        final
          ? "Estos son los análisis parciales, en orden, de las partes consecutivas de la misma reunión. Combínalos en el informe final de toda la reunión: une temas, decisiones y tareas sin duplicados, conserva las marcas de tiempo, escribe un «summary» de la reunión completa y redacta el «follow_up_email»."
          : "Estos son análisis parciales consecutivos de la misma reunión. Combínalos en uno solo sin duplicados, conservando las marcas de tiempo. Deja «follow_up_email» vacío.",
        "",
        "<analisis_parciales>",
        JSON.stringify(group),
        "</analisis_parciales>",
      ].join("\n"),
      maxTokens: REDUCE_OUTPUT_TOKENS,
      budget,
      gate,
    });
  }
}
