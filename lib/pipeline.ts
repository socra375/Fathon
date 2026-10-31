import { q } from "./db";
import { env } from "./env";
import { analyze, emptyAnalysis, type Analysis } from "./analyze";
import { renderReportEmail, sendEmail } from "./email";
import { mergeUtterances, PLATFORM_NAMES, talkShares, transcriptToText, type Utterance } from "./format";
import { getSettings } from "./settings";
import { transcribe } from "./transcribe";
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
  language: string | null;
  timezone: string | null;
  analysis: Analysis | null;
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
export async function claimForProcessing(id: string): Promise<MeetingRow | null> {
  const rows = await q<MeetingRow>(
    `UPDATE meetings
        SET status = 'processing', error = NULL, updated_at = now(),
            ended_at = COALESCE(ended_at, now())
      WHERE id = $1
        AND (status <> 'processing' OR updated_at < now() - interval '10 minutes')
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

async function setStage(id: string, stage: string) {
  await q("UPDATE meetings SET stage = $2, updated_at = now() WHERE id = $1", [id, stage]);
}

export async function loadAudio(id: string): Promise<Buffer> {
  const rows = await q<{ seq: number; data: Buffer }>(
    "SELECT seq, data FROM audio_chunks WHERE meeting_id = $1 ORDER BY seq",
    [id],
  );
  if (rows.length === 0) throw new Error("No se recibió audio de esta reunión.");
  if (rows[0].seq !== 0) throw new Error("Falta el primer fragmento de audio; la grabación no se puede reconstruir.");
  // Los fragmentos de MediaRecorder (WebM/Opus) forman un archivo válido al concatenarlos en orden.
  return Buffer.concat(rows.map((r) => r.data));
}

export function dashboardLink(id: string, baseUrl?: string | null): string | null {
  const base = baseUrl ?? env.appUrl();
  return base ? `${base.replace(/\/$/, "")}/dashboard/meetings/${id}` : null;
}

/**
 * Pipeline completo: audio → transcripción → análisis → correo.
 * Es reanudable: si un paso ya se completó en un intento anterior, se salta.
 */
export async function processMeeting(id: string, baseUrl?: string | null): Promise<void> {
  const claimed = await claimForProcessing(id);
  if (!claimed) return;
  let m = claimed;
  const settings = await getSettings();
  let stage = "transcribing";

  try {
    // 1. Transcripción
    if (!m.transcript) {
      await setStage(id, stage);
      const audio = await loadAudio(id);
      const result = await transcribe(audio, settings.transcriptionLanguage);
      const utts = mergeUtterances(result.utterances);
      const text = transcriptToText(utts, settings.reportLanguage);
      // El cronómetro de la extensión es más fiable que la cabecera del WebM.
      const duration = m.duration_sec || result.durationSec || 0;
      [m] = await q<MeetingRow>(
        `UPDATE meetings SET transcript = $2, transcript_text = $3, language = $4,
                duration_sec = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(utts), text, result.language, duration],
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
          : await analyze({
              transcriptText: m.transcript_text ?? "",
              platform: PLATFORM_NAMES[m.platform] ?? m.platform,
              title: m.title,
              startedAt: new Date(m.started_at),
              durationSec: m.duration_sec ?? 0,
              talk,
              reportLanguage: settings.reportLanguage,
            });
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
    console.error(`[minuta] meeting ${id} failed at ${stage}:`, err);
    await q("UPDATE meetings SET status = 'failed', stage = $2, error = $3, updated_at = now() WHERE id = $1", [
      id,
      stage,
      errorMessage(err).slice(0, 1000),
    ]);
  }
}
