/**
 * Análisis de la reunión con rotación de proveedores de IA.
 *
 * 1. Si la transcripción cabe en algún proveedor con ventana grande (Claude, Gemini, OpenRouter),
 *    se analiza de una sola vez: es lo que da el mejor resultado.
 * 2. Si no cabe, o esos proveedores están en pausa, se divide en tramos pequeños que caben en
 *    cualquier proveedor (también Groq, con ~8.000 tokens por minuto). Cada tramo se analiza con
 *    el primer proveedor disponible, se guarda al terminar, y al final se combinan.
 *
 * En ambos casos, si un proveedor responde «límite alcanzado» se anota la pausa y se pasa al siguiente.
 */
import { ANALYSIS_JSON_SCHEMA, AnalysisError, meetingHeader, parseAnalysis, systemPrompt, type Analysis, type AnalyzeInput } from "./analyze";
import { Budget, RetryLater } from "./budget";
import { dbCooldowns } from "./cooldowns";
import { env } from "./env";
import { estimateTokens, JSON_HINT, llmProviders, type LlmProvider, type LlmRequest } from "./llm";
import { AllProvidersFailed, rotate, type CooldownStore } from "./rotator";

export interface AnalysisProgress {
  /** Análisis parciales ya hechos, por índice de tramo. */
  parts: (Analysis | null)[];
  save: (parts: (Analysis | null)[]) => Promise<void>;
}

export interface AnalysisContext {
  budget: Budget;
  progress: AnalysisProgress;
  store?: CooldownStore;
  providers?: LlmProvider[];
}

const MAP_OUTPUT_TOKENS = 1800;
const REDUCE_OUTPUT_TOKENS = 3000;
const SINGLE_OUTPUT_TOKENS = 6000;

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

async function ask(providers: LlmProvider[], req: Omit<LlmRequest, "schema">, ctx: AnalysisContext): Promise<Analysis> {
  const need = estimateTokens(req.system + JSON_HINT + req.user);
  const usable = providers.filter((p) => p.maxInputTokens >= need);
  if (usable.length === 0) throw new AllProvidersFailed("Ningún proveedor de IA admite una petición tan grande.", []);
  const full: LlmRequest = { ...req, schema: ANALYSIS_JSON_SCHEMA };
  const result = await rotate(
    usable.map((p) => ({
      id: p.id,
      label: p.label,
      // Si el JSON no es válido para este proveedor, se prueba con el siguiente.
      run: async () => parseAnalysis(await p.complete(full)),
    })),
    { namespace: "analysis", store: ctx.store ?? dbCooldowns, budget: ctx.budget },
  );
  return result.value;
}

export async function analyzeRotating(input: AnalyzeInput, ctx: AnalysisContext): Promise<Analysis> {
  const providers = ctx.providers ?? llmProviders();
  if (providers.length === 0) {
    throw new AnalysisError("Falta configurar el análisis: añade GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY (gratis) o ANTHROPIC_API_KEY.");
  }
  const system = systemPrompt(input.reportLanguage);
  const header = meetingHeader(input);

  // 1. Una sola petición, con los proveedores que admiten toda la transcripción.
  const single = [header, "", "<transcripcion>", input.transcriptText, "</transcripcion>", "", "Genera el informe de la reunión siguiendo el esquema."].join("\n");
  const needSingle = estimateTokens(system + JSON_HINT + single);
  const big = providers.filter((p) => p.maxInputTokens >= needSingle);
  if (big.length > 0 && env.analysisMode() === "auto") {
    try {
      return await ask(big, { system, user: single, maxTokens: SINGLE_OUTPUT_TOKENS }, ctx);
    } catch (err) {
      const recoverable = err instanceof RetryLater || err instanceof AllProvidersFailed;
      // Si no hay proveedores pequeños que probar, se propaga (esperar o avisar).
      if (!recoverable || big.length === providers.length) throw err;
    }
  }

  // 2. Por tramos, con todos los proveedores.
  const chunks = splitTranscript(input.transcriptText, env.analysisChunkTokens());
  const parts = chunks.map((_, i) => ctx.progress.parts[i] ?? null);
  for (let i = 0; i < chunks.length; i++) {
    if (parts[i]) continue;
    parts[i] = await ask(
      providers,
      {
        system,
        user: [
          header,
          "",
          chunks.length > 1
            ? `Esta es la PARTE ${i + 1} de ${chunks.length} de la transcripción. Analiza solo lo que aparece en esta parte; otro paso combinará todas las partes. En «summary» resume solo esta parte y en «follow_up_email» deja subject y body vacíos.`
            : "Genera el informe de la reunión siguiendo el esquema.",
          "",
          "<transcripcion>",
          chunks[i],
          "</transcripcion>",
        ].join("\n"),
        maxTokens: chunks.length > 1 ? MAP_OUTPUT_TOKENS : REDUCE_OUTPUT_TOKENS,
      },
      ctx,
    );
    await ctx.progress.save(parts);
    ctx.budget.markProgress();
  }
  if (chunks.length === 1) return parts[0] as Analysis;

  // 3. Combinar. Si los parciales no caben en una petición, se combinan por grupos.
  const reduce = (group: Analysis[], final: boolean) =>
    ask(
      providers,
      {
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
      },
      ctx,
    );

  let level = parts as Analysis[];
  const smallest = Math.min(...providers.map((p) => p.maxInputTokens));
  const limit = Math.min(env.analysisChunkTokens(), Math.floor(smallest * 0.6));
  while (estimateTokens(JSON.stringify(level)) > limit && level.length > 1) {
    const groups: Analysis[][] = [];
    let cur: Analysis[] = [];
    for (const p of level) {
      if (cur.length && estimateTokens(JSON.stringify([...cur, p])) > limit) {
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
}
