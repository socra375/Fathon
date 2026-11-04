import { dbCooldowns } from "./cooldowns";
import { env } from "./env";
import { smtpConfigured } from "./mailer";

export interface ProviderRow {
  id: string;
  label: string;
  /** Variable(s) de entorno que activan este proveedor. */
  keyName: string;
  configured: boolean;
  /** Si está en pausa por haber alcanzado su límite: hasta cuándo y por qué. */
  blockedUntil: Date | null;
  reason: string;
}

export interface ProviderGroups {
  stt: ProviderRow[];
  analysis: ProviderRow[];
  email: ProviderRow[];
}

const STT = {
  groq: { label: "Groq · Whisper (gratis)", keyName: "GROQ_API_KEY" },
  deepgram: { label: "Deepgram (crédito inicial gratis)", keyName: "DEEPGRAM_API_KEY" },
};
const ANALYSIS = {
  claude: { label: "Claude (de pago)", keyName: "ANTHROPIC_API_KEY" },
  gemini: { label: "Gemini (gratis)", keyName: "GEMINI_API_KEY" },
  openrouter: { label: "OpenRouter (gratis)", keyName: "OPENROUTER_API_KEY" },
  groq: { label: "Groq (gratis)", keyName: "GROQ_API_KEY" },
};
const EMAIL = {
  resend: { label: "Resend", keyName: "RESEND_API_KEY" },
  smtp: { label: "SMTP / Gmail", keyName: "SMTP_USER + SMTP_PASS" },
};

function build<T extends string>(
  namespace: string,
  order: T[],
  all: Record<T, { label: string; keyName: string }>,
  has: Record<T, boolean>,
  blocked: Map<string, { until: number; reason: string }>,
): ProviderRow[] {
  const ids = [...order.filter((id) => id in all), ...(Object.keys(all) as T[]).filter((id) => !order.includes(id))];
  return ids.map((id) => {
    const b = blocked.get(`${namespace}:${id}`);
    return {
      id,
      ...all[id],
      configured: has[id],
      blockedUntil: b ? new Date(b.until) : null,
      reason: b?.reason ?? "",
    };
  });
}

/** Estado de cada proveedor, en el orden en que se usan. */
export async function providerStatus(): Promise<ProviderGroups> {
  let blocked = new Map<string, { until: number; reason: string }>();
  try {
    blocked = await dbCooldowns.all();
  } catch {
    /* sin base de datos todavía: se muestra sin pausas */
  }
  return {
    stt: build("stt", env.transcriptionOrder(), STT, { groq: Boolean(env.groqKey()), deepgram: Boolean(env.deepgramKey()) }, blocked),
    analysis: build(
      "analysis",
      env.analysisOrder(),
      ANALYSIS,
      { claude: Boolean(env.anthropicKey()), gemini: Boolean(env.geminiKey()), openrouter: Boolean(env.openrouterKey()), groq: Boolean(env.groqKey()) },
      blocked,
    ),
    email: build("email", env.emailOrder(), EMAIL, { resend: Boolean(env.resendKey()), smtp: smtpConfigured() }, blocked),
  };
}

/** «6 min», «2 h 10 min». */
export function humanWait(until: Date, now = Date.now()): string {
  const min = Math.max(1, Math.ceil((until.getTime() - now) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
