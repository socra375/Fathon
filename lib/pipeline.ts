import { q } from "./db";
import { env } from "./env";
import { analyzeWithClaude, emptyAnalysis, type Analysis, type AnalyzeInput } from "./analyze";
import { analyzeWithGroq } from "./analyze-groq";
import { Budget, ContinueLater } from "./budget";
import { renderReportEmail, sendEmail } from "./email";
import { mergeUtterances, PLATFORM_NAMES, talkShares, transcriptToText, type Utterance } from "./format";
import { getSettings, type TranscriptionLanguage as TranscriptionLanguageSetting } from "./settings";
import { toUtterances, transcribeTrack, TranscriptionError, type Track } from "./transcribe";
import { errorMessage } from "./http";

export interface MeetingRow {
  id: string;
  platform: string;
  title: string;
  meeting_url: string | null;
  status: "recording" | "processing" | "done" | "failed";
  stage: string | null;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_sec: number | null;
  audio_bytes: string; // bigint llega como texto
  chunk_count: number;
  transcript: Utterance[] | null;
  transcript_text: string | null;
  transcript_parts: Record<string, TranscriptPart>;
  language: string | null;
  timezone: string | null;
  analysis: Analysis | null;
  analysis_parts: (Analysis | null)[];
  continuations: number;
  email_to: string | null;
  email_id: string | null;
  emailed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Marca la reunión como "processing" de forma atómica. Devuelve null si ya la está
 * procesando otro proceso (salvo que lleve más de 10 min atascada).
 */
export async function claimForProcessing(id: string, continuation = false): Promise<MeetingRow | null> {
  // Una continuación la pide la propia invocación que suelta la reunión, así que puede tomarla
  // aunque siga marcada como "processing". Un reintento manual pone a cero el contador.
  const rows = await q<MeetingRow>(
    `UPDATE meetings
        SET status = 'processing', error = NULL, updated_at = now(),
            ended_at = COALESCE(ended_at, now()),
            continuations = CASE WHEN $2 THEN continuations ELSE 0 END
      WHERE id = $1
        AND ($2 OR status <> 'processing' OR updated_at < now() - interval '10 minutes')
      RETURNING *`,
    [id, continuation],
  );
  return rows[0] ?? null;
}

async function setStage(id: string, stage: string) {
  await q("UPDATE meetings SET stage = $2, updated_at = now() WHERE id = $1", [id, stage]);
}

export interface TranscriptPart {
  utterances: Utterance[];
  language: string | null;
  warning?: string;
}

export interface AudioGroup {
  track: Track;
  seg: number;
  segStartMs: number;
  chunks: number;
}

/** Pistas y segmentos recibidos. Cada segmento es un WebM independiente. */
export async function listAudioGroups(id: string): Promise<AudioGroup[]> {
  const rows = await q<{ track: Track; seg: number; seg_start_ms: number; chunks: string }>(
    `SELECT track, seg, min(seg_start_ms) AS seg_start_ms, count(*) AS chunks
       FROM audio_chunks WHERE meeting_id = $1
      GROUP BY track, seg ORDER BY seg, track`,
    [id],
  );
  return rows.map((r) => ({
    track: r.track,
    seg: r.seg,
    segStartMs: r.seg_start_ms,
    chunks: Number(r.chunks),
  }));
}

/** Une los fragmentos de un segmento: los de MediaRecorder (WebM/Opus) forman un archivo válido en orden. */
export async function loadSegmentAudio(id: string, track: Track, seg: number): Promise<Buffer> {
  const rows = await q<{ data: Buffer }>(
    "SELECT data FROM audio_chunks WHERE meeting_id = $1 AND track = $2 AND seg = $3 ORDER BY seq",
    [id, track, seg],
  );
  return Buffer.concat(rows.map((r) => r.data));
}

/**
 * Transcribe cada pista/segmento que falte y guarda el progreso tras cada uno, de modo que
 * si se alcanza el límite gratuito del proveedor, «Reintentar» continúa donde se quedó.
 */
async function transcribeAll(
  m: MeetingRow,
  language: TranscriptionLanguageSetting,
  budget: Budget,
): Promise<Record<string, TranscriptPart>> {
  const groups = await listAudioGroups(m.id);
  if (groups.length === 0) throw new Error("No se recibió audio de esta reunión.");
  const parts: Record<string, TranscriptPart> = { ...(m.transcript_parts ?? {}) };
  for (const g of groups) {
    const key = `${g.track}:${g.seg}`;
    if (parts[key]) continue;
    budget.ensure(60_000);
    const audio = await loadSegmentAudio(m.id, g.track, g.seg);
    let part: TranscriptPart;
    try {
      let r;
      try {
        r = await transcribeTrack(audio, g.track, language, `${g.track}-${g.seg}.webm`);
      } catch (err) {
        // Límite por minuto del plan gratuito: si la espera es corta, se espera y se reintenta una vez.
        if (!(err instanceof TranscriptionError) || err.retryAfterSec === undefined || err.retryAfterSec > 90) throw err;
        await budget.wait(err.retryAfterSec * 1000 + 500);
        r = await transcribeTrack(audio, g.track, language, `${g.track}-${g.seg}.webm`);
      }
      part = { utterances: toUtterances(g.track, r.segments, g.segStartMs / 1000), language: r.language };
    } catch (err) {
      if (err instanceof ContinueLater) throw err;
      // El límite de uso y la falta de configuración detienen el proceso (se puede reintentar).
      // Un segmento dañado (p. ej. perdió su primer fragmento) se omite para no perder el resto.
      const recoverable = err instanceof TranscriptionError && (err.retryAfterSec !== undefined || /^Falta/.test(err.message));
      if (recoverable) throw err;
      part = { utterances: [], language: null, warning: errorMessage(err).slice(0, 300) };
    }
    parts[key] = part;
    await q("UPDATE meetings SET transcript_parts = transcript_parts || $2::jsonb, updated_at = now() WHERE id = $1", [
      m.id,
      JSON.stringify({ [key]: part }),
    ]);
    budget.markProgress();
  }
  if (Object.values(parts).every((p) => p.warning)) {
    throw new Error(`No se pudo transcribir ningún segmento: ${Object.values(parts)[0]?.warning ?? ""}`);
  }
  return parts;
}

export function dashboardLink(id: string, baseUrl?: string | null): string | null {
  const base = baseUrl ?? env.appUrl();
  return base ? `${base.replace(/\/$/, "")}/dashboard/meetings/${id}` : null;
}

/** Análisis con Claude (si hay clave) o gratis con Groq. */
export async function runAnalysis(m: MeetingRow, input: AnalyzeInput, budget: Budget): Promise<Analysis> {
  const provider = env.analysisProvider();
  if (provider === "claude") return analyzeWithClaude(input);
  if (provider === "groq") {
    return analyzeWithGroq(input, budget, {
      parts: m.analysis_parts ?? [],
      save: async (parts) => {
        await q("UPDATE meetings SET analysis_parts = $2::jsonb, updated_at = now() WHERE id = $1", [m.id, JSON.stringify(parts)]);
      },
    });
  }
  throw new Error("Falta configurar el análisis: añade ANTHROPIC_API_KEY (Claude) o GROQ_API_KEY (gratis).");
}

const MAX_CONTINUATIONS = 40;

/**
 * Pide al propio servidor que siga procesando la reunión en una invocación nueva
 * (cada función de Vercel tiene un tiempo máximo).
 */
async function scheduleContinuation(id: string, baseUrl: string | null | undefined): Promise<boolean> {
  const base = (baseUrl ?? env.appUrl())?.replace(/\/$/, "");
  const key = env.apiKey();
  if (!base || !key) return false;
  try {
    const res = await fetch(`${base}/api/meetings/${id}/retry?continue=1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    return res.status < 400;
  } catch (err) {
    console.error(`[minuta] no se pudo programar la continuación de ${id}:`, err);
    return false;
  }
}

/**
 * Pipeline completo: audio → transcripción → análisis → correo.
 * Es reanudable: si un paso ya se completó en un intento anterior, se salta. Si se agota el
 * tiempo de la invocación, guarda el progreso y continúa en otra.
 */
export async function processMeeting(
  id: string,
  baseUrl?: string | null,
  opts: { continuation?: boolean } = {},
): Promise<void> {
  const budget = Budget.fromNow(env.processingBudgetMs());
  const claimed = await claimForProcessing(id, opts.continuation === true);
  if (!claimed) return;
  let m = claimed;
  const settings = await getSettings();
  let stage = "transcribing";

  try {
    // 1. Transcripción (por pista y segmento, reanudable)
    if (!m.transcript) {
      await setStage(id, stage);
      const parts = await transcribeAll(m, settings.transcriptionLanguage, budget);
      const utts = mergeUtterances(Object.values(parts).flatMap((p) => p.utterances));
      const text = transcriptToText(utts, settings.reportLanguage);
      const language = Object.values(parts).find((p) => p.language)?.language ?? null;
      // El cronómetro de la extensión manda; si no llegó, se estima con la última intervención.
      const duration = m.duration_sec || Math.round(Math.max(0, ...utts.map((u) => u.end)));
      [m] = await q<MeetingRow>(
        `UPDATE meetings SET transcript = $2, transcript_text = $3, language = $4, duration_sec = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(utts), text, language, duration],
      );
    }

    // 2. Análisis con IA
    stage = "analyzing";
    if (!m.analysis) {
      await setStage(id, stage);
      const utts = m.transcript ?? [];
      const talk = talkShares(utts);
      const analysis =
        utts.length === 0 || (m.transcript_text ?? "").trim().length < 20
          ? emptyAnalysis(settings.reportLanguage)
          : await runAnalysis(
              m,
              {
                transcriptText: m.transcript_text ?? "",
                platform: PLATFORM_NAMES[m.platform] ?? m.platform,
                title: m.title,
                startedAt: new Date(m.started_at),
                durationSec: m.duration_sec ?? 0,
                talk,
                reportLanguage: settings.reportLanguage,
              },
              budget,
            );
      [m] = await q<MeetingRow>(
        "UPDATE meetings SET analysis = $2, title = CASE WHEN $3 <> '' THEN $3 ELSE title END, updated_at = now() WHERE id = $1 RETURNING *",
        [id, JSON.stringify(analysis), analysis.title],
      );
    }

    // 3. Correo
    stage = "emailing";
    if (!m.emailed_at) {
      await setStage(id, stage);
      const to = (m.email_to || settings.emailTo).split(",").map((s) => s.trim()).filter(Boolean);
      if (to.length === 0) throw new Error("No hay destinatario de correo configurado (Ajustes → Correo).");
      const talk = talkShares(m.transcript ?? []);
      const mail = renderReportEmail({
        meetingId: id,
        platform: m.platform,
        startedAt: new Date(m.started_at),
        timezone: m.timezone,
        durationSec: m.duration_sec ?? 0,
        analysis: m.analysis!,
        talk,
        transcriptText: m.transcript_text ?? "",
        dashboardUrl: dashboardLink(id, baseUrl),
      });
      const date = new Date(m.started_at).toISOString().slice(0, 10);
      const emailId = await sendEmail({
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: m.transcript_text
          ? [{ filename: `transcripcion-${date}.txt`, content: m.transcript_text }]
          : undefined,
      });
      await q(
        "UPDATE meetings SET emailed_at = now(), email_id = $2, email_to = $3, updated_at = now() WHERE id = $1",
        [id, emailId, to.join(", ")],
      );
    }

    await q("UPDATE meetings SET status = 'done', stage = NULL, error = NULL, updated_at = now() WHERE id = $1", [id]);
    if (!settings.keepAudio) await q("DELETE FROM audio_chunks WHERE meeting_id = $1", [id]);
  } catch (err) {
    if (err instanceof ContinueLater) {
      const n = (m.continuations ?? 0) + 1;
      if (n <= MAX_CONTINUATIONS) {
        await q("UPDATE meetings SET continuations = $2, updated_at = now() WHERE id = $1", [id, n]);
        if (await scheduleContinuation(id, baseUrl)) return;
      }
      err = new Error(
        n > MAX_CONTINUATIONS
          ? "El procesamiento tardó demasiado (límites del plan gratuito). Pulsa «Reintentar» más tarde."
          : `${err.message}. No se pudo continuar automáticamente: pulsa «Reintentar».`,
      );
    }
    console.error(`[minuta] meeting ${id} failed at ${stage}:`, err);
    await q("UPDATE meetings SET status = 'failed', stage = $2, error = $3, updated_at = now() WHERE id = $1", [
      id,
      stage,
      errorMessage(err).slice(0, 1000),
    ]);
  }
}
