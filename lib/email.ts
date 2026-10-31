import { env } from "./env";
import type { Analysis } from "./analyze";
import { clock, escapeHtml as e, formatDate, PLATFORM_NAMES, speakerLabel, type TalkShare } from "./format";

export interface ReportEmailInput {
  meetingId: string;
  platform: string;
  startedAt: Date;
  timezone?: string | null;
  durationSec: number;
  analysis: Analysis;
  talk: TalkShare[];
  transcriptText: string;
  dashboardUrl: string | null;
}

const SENTIMENT_ES: Record<Analysis["sentiment"]["overall"], string> = {
  positive: "Positivo",
  neutral: "Neutral",
  negative: "Negativo",
  mixed: "Mixto",
};

const C = {
  ink: "#16181d",
  muted: "#5d6472",
  line: "#e6e8ec",
  bg: "#f5f6f8",
  accent: "#3b5bdb",
  accentSoft: "#eef2ff",
};

function section(title: string, inner: string): string {
  if (!inner) return "";
  return `<tr><td style="padding:20px 28px 0">
    <h2 style="margin:0 0 10px;font:600 15px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink};text-transform:uppercase;letter-spacing:.04em">${e(title)}</h2>
    ${inner}
  </td></tr>`;
}

function list(items: string[]): string {
  if (items.length === 0) return "";
  return `<ul style="margin:0;padding-left:20px;color:${C.ink};font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">${items
    .map((i) => `<li style="margin:0 0 6px">${e(i)}</li>`)
    .join("")}</ul>`;
}

export function renderReportEmail(input: ReportEmailInput): { subject: string; html: string; text: string } {
  const a = input.analysis;
  const platform = PLATFORM_NAMES[input.platform] ?? "Reunión";
  const when = formatDate(input.startedAt, input.timezone);
  const subject = `Minuta · ${a.title}`.slice(0, 150);

  const actions = a.action_items.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <tr>
          <th align="left" style="padding:8px;border-bottom:1px solid ${C.line};color:${C.muted};font-weight:600">Responsable</th>
          <th align="left" style="padding:8px;border-bottom:1px solid ${C.line};color:${C.muted};font-weight:600">Tarea</th>
          <th align="left" style="padding:8px;border-bottom:1px solid ${C.line};color:${C.muted};font-weight:600">Plazo</th>
        </tr>
        ${a.action_items
          .map(
            (t) => `<tr>
          <td valign="top" style="padding:8px;border-bottom:1px solid ${C.line};color:${C.ink};white-space:nowrap">${e(t.owner)}</td>
          <td valign="top" style="padding:8px;border-bottom:1px solid ${C.line};color:${C.ink}">${e(t.task)}</td>
          <td valign="top" style="padding:8px;border-bottom:1px solid ${C.line};color:${C.muted};white-space:nowrap">${e(t.due || "—")}</td>
        </tr>`,
          )
          .join("")}
      </table>`
    : "";

  const topics = a.topics.length
    ? a.topics
        .map(
          (t) => `<p style="margin:0 0 10px;font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">
        <span style="display:inline-block;min-width:52px;color:${C.accent};font-weight:600">${e(t.start)}</span>
        <strong>${e(t.title)}</strong><br><span style="color:${C.muted}">${e(t.summary)}</span></p>`,
        )
        .join("")
    : "";

  const names = new Map(a.speakers.map((s) => [s.label.toLowerCase(), s]));
  const talk = input.talk.length
    ? input.talk
        .map((t) => {
          const label = speakerLabel(t.speaker);
          const info = names.get(label.toLowerCase());
          const name = info?.likely_name ? `${label} (${info.likely_name})` : label;
          return `<div style="margin:0 0 10px;font:14px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">
          <div><strong>${e(name)}</strong> <span style="color:${C.muted}">· ${t.pct}% · ${clock(t.seconds)}</span></div>
          <div style="background:${C.line};height:6px;border-radius:3px;margin:4px 0"><div style="background:${C.accent};width:${Math.max(2, t.pct)}%;height:6px;border-radius:3px"></div></div>
          ${info?.contribution ? `<div style="color:${C.muted}">${e(info.contribution)}</div>` : ""}
        </div>`;
        })
        .join("")
    : "";

  const sentiment = a.sentiment.explanation
    ? `<p style="margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}"><strong>${SENTIMENT_ES[a.sentiment.overall]}.</strong> ${e(a.sentiment.explanation)}</p>`
    : "";

  const followUp = a.follow_up_email.body
    ? `<div style="background:${C.bg};border:1px solid ${C.line};border-radius:8px;padding:14px 16px;font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">
        <div style="color:${C.muted};margin-bottom:8px">Asunto: <strong style="color:${C.ink}">${e(a.follow_up_email.subject)}</strong></div>
        ${e(a.follow_up_email.body).replace(/\n/g, "<br>")}
      </div>`
    : "";

  const button = input.dashboardUrl
    ? `<tr><td style="padding:24px 28px 0"><a href="${e(input.dashboardUrl)}" style="display:inline-block;background:${C.accent};color:#fff;text-decoration:none;font:600 14px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:11px 18px;border-radius:8px">Ver la reunión completa</a></td></tr>`
    : "";

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.bg};padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid ${C.line};border-radius:12px;overflow:hidden">
  <tr><td style="padding:22px 28px;border-bottom:1px solid ${C.line}">
    <div style="font:700 16px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.accent}">● Minuta</div>
    <h1 style="margin:10px 0 6px;font:700 22px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">${e(a.title)}</h1>
    <div style="font:14px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.muted}">${e(platform)} · ${e(when)} · ${clock(input.durationSec)}</div>
  </td></tr>
  <tr><td style="padding:20px 28px 0">
    <div style="background:${C.accentSoft};border-radius:8px;padding:14px 16px;font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">${e(a.summary)}</div>
  </td></tr>
  ${section("Puntos clave", list(a.key_points))}
  ${section("Decisiones", list(a.decisions))}
  ${section("Tareas", actions)}
  ${section("Temas", topics)}
  ${section("Preguntas abiertas", list(a.open_questions))}
  ${section("Riesgos y objeciones", list(a.risks))}
  ${section("Participación", talk)}
  ${section("Tono de la reunión", sentiment)}
  ${section("Correo de seguimiento sugerido", followUp)}
  ${button}
  <tr><td style="padding:24px 28px;color:${C.muted};font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">La transcripción completa va adjunta. Generado automáticamente por Minuta; la IA puede cometer errores, revisa los datos importantes.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    a.title,
    `${platform} · ${when} · ${clock(input.durationSec)}`,
    "",
    a.summary,
    "",
    a.decisions.length ? `Decisiones:\n${a.decisions.map((d) => `- ${d}`).join("\n")}\n` : "",
    a.action_items.length ? `Tareas:\n${a.action_items.map((t) => `- ${t.owner}: ${t.task}${t.due ? ` (${t.due})` : ""}`).join("\n")}\n` : "",
    input.dashboardUrl ? `Ver la reunión: ${input.dashboardUrl}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { subject, html, text };
}

export class EmailError extends Error {}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string }[];
}): Promise<string> {
  const key = env.resendKey();
  if (!key) throw new EmailError("Falta RESEND_API_KEY");
  const res = await fetch(`${env.resendUrl()}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.emailFrom(),
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "utf8").toString("base64"),
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new EmailError(`Resend respondió ${res.status}: ${body.slice(0, 400)}`);
  try {
    return (JSON.parse(body) as { id?: string }).id ?? "";
  } catch {
    return "";
  }
}
