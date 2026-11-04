/**
 * Envío del informe por correo a varias personas.
 *
 * Se envía a cada destinatario por separado, así que un rechazo no impide que lleguen los demás.
 * Para cada uno se prueban los proveedores en orden:
 *
 *  - resend   API HTTP. Sin dominio verificado solo envía a la dirección con la que te registraste
 *             (es un límite de Resend: el resto de destinatarios pasa al proveedor siguiente).
 *  - smtp     Cualquier servidor SMTP; la opción habitual es Gmail con una «contraseña de aplicación»,
 *             que permite enviar a cualquiera sin comprar un dominio.
 */
import nodemailer from "nodemailer";
import { env, type MailId } from "./env";
import { dbCooldowns } from "./cooldowns";
import { classifyHttpError, ProviderLimit, rotate, type Candidate, type CooldownStore } from "./rotator";

export interface MailMessage {
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string }[];
}

export interface Delivered {
  to: string;
  via: MailId;
  id: string;
}
export interface Failed {
  to: string;
  error: string;
}
export interface DeliveryResult {
  delivered: Delivered[];
  failed: Failed[];
}

// ---------------------------------------------------------------- destinatarios

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function isValidRecipient(s: string): boolean {
  return EMAIL_RE.test(s) && s.length <= 254;
}

/** Separa por comas, punto y coma, espacios o saltos de línea; quita repetidos sin distinguir mayúsculas. */
export function parseRecipients(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text ?? "").split(/[\s,;]+/)) {
    const e = raw.trim();
    if (!e) continue;
    const k = e.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export const MAX_RECIPIENTS = 10;

/** `null` si la lista es válida; si no, el motivo. */
export function validateRecipients(text: string): string | null {
  const list = parseRecipients(text);
  if (list.length === 0) return "Indica al menos un correo.";
  if (list.length > MAX_RECIPIENTS) return `Máximo ${MAX_RECIPIENTS} destinatarios.`;
  const bad = list.find((e) => !isValidRecipient(e));
  return bad ? `«${bad}» no es un correo válido.` : null;
}

// ---------------------------------------------------------------- proveedores

export interface SmtpLike {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    attachments?: { filename: string; content: string }[];
  }): Promise<{ messageId?: string }>;
}

export function smtpConfigured(): boolean {
  return Boolean(env.smtpUser() && env.smtpPass());
}

function createSmtp(): SmtpLike {
  return nodemailer.createTransport({
    host: env.smtpHost(),
    port: env.smtpPort(),
    secure: env.smtpPort() === 465,
    auth: { user: env.smtpUser(), pass: env.smtpPass() },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/** Errores de nodemailer → pausa del proveedor o fallo de este destinatario. */
export function classifySmtpError(err: unknown): Error {
  const e = err as { code?: string; responseCode?: number; message?: string; response?: string };
  const msg = `smtp: ${e.response ?? e.message ?? String(err)}`.slice(0, 260);
  if (e.code === "EAUTH" || e.responseCode === 535) {
    return new ProviderLimit(`${msg} (revisa SMTP_USER y SMTP_PASS: en Gmail hace falta una contraseña de aplicación)`, "smtp", 6 * 3_600_000, "auth");
  }
  if (/daily user sending limit|5\.4\.5|quota/i.test(msg)) return new ProviderLimit(msg, "smtp", 6 * 3_600_000, "quota");
  if (e.code === "ECONNECTION" || e.code === "ETIMEDOUT" || e.code === "ESOCKET" || e.code === "EDNS" || (e.responseCode ?? 0) >= 421 && (e.responseCode ?? 0) < 500) {
    return new ProviderLimit(msg, "smtp", 120_000, "overload");
  }
  return new Error(msg);
}

export interface DeliverOptions {
  store?: CooldownStore;
  /** Para pruebas. */
  smtp?: SmtpLike;
  fetchImpl?: typeof fetch;
}

async function sendViaResend(to: string, msg: MailMessage, fetchImpl: typeof fetch): Promise<string> {
  const key = env.resendKey();
  if (!key) throw new Error("falta RESEND_API_KEY");
  let res: Response;
  try {
    res = await fetchImpl(`${env.resendUrl()}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.emailFrom(),
        to: [to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, "utf8").toString("base64") })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ProviderLimit(`resend: sin respuesta (${err instanceof Error ? err.message : err})`, "resend", 120_000, "overload");
  }
  const body = await res.text();
  if (!res.ok) {
    // Sin dominio verificado, Resend solo deja escribir a la cuenta propia. Es un límite del destinatario,
    // no del proveedor: no se pausa Resend, solo se prueba el siguiente proveedor para esta dirección.
    if (res.status === 403 && /testing emails|verify a domain/i.test(body)) {
      const own = /\(([^)\s]+@[^)\s]+)\)/.exec(body)?.[1];
      throw new Error(`resend solo envía a ${own ?? "la cuenta con la que te registraste"} hasta que verifiques un dominio`);
    }
    throw classifyHttpError("resend", res.status, res.headers, body);
  }
  try {
    return (JSON.parse(body) as { id?: string }).id ?? "";
  } catch {
    return "";
  }
}

/** Los proveedores de correo con configuración, en el orden elegido. */
export function mailProviders(): { id: MailId; label: string }[] {
  const has: Record<MailId, boolean> = { resend: Boolean(env.resendKey()), smtp: smtpConfigured() };
  const labels: Record<MailId, string> = { resend: "Resend", smtp: "SMTP" };
  const out: { id: MailId; label: string }[] = [];
  for (const id of env.emailOrder()) if (has[id] && !out.some((o) => o.id === id)) out.push({ id, label: labels[id] });
  return out;
}

/** Envía el informe a cada destinatario por separado y dice quién lo recibió y a quién no se pudo enviar. */
export async function deliverReport(recipients: string[], msg: MailMessage, opts: DeliverOptions = {}): Promise<DeliveryResult> {
  const providers = mailProviders();
  const result: DeliveryResult = { delivered: [], failed: [] };
  if (providers.length === 0) {
    for (const to of recipients) result.failed.push({ to, error: "No hay ningún servicio de correo configurado (RESEND_API_KEY o SMTP_USER y SMTP_PASS)." });
    return result;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let smtp = opts.smtp;

  for (const to of recipients) {
    const candidates: Candidate<string>[] = providers.map((p) => ({
      id: p.id,
      label: p.label,
      run: async () => {
        if (p.id === "resend") return sendViaResend(to, msg, fetchImpl);
        smtp ??= createSmtp();
        try {
          const info = await smtp.sendMail({ from: env.smtpFrom() ?? env.smtpUser() ?? "", to, subject: msg.subject, html: msg.html, text: msg.text, attachments: msg.attachments });
          return info.messageId ?? "";
        } catch (err) {
          throw classifySmtpError(err);
        }
      },
    }));
    try {
      const r = await rotate(candidates, { namespace: "email", store: opts.store ?? dbCooldowns });
      result.delivered.push({ to, via: r.provider as MailId, id: r.value });
    } catch (err) {
      result.failed.push({ to, error: err instanceof Error ? err.message.slice(0, 400) : String(err) });
    }
  }
  return result;
}

/** Texto para guardar y mostrar: «a@x.com (motivo); b@y.com (motivo)». */
export function describeFailures(failed: Failed[]): string {
  return failed.map((f) => `${f.to}: ${f.error}`).join(" | ").slice(0, 1500);
}
