/** Lectura centralizada de variables de entorno. */

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const env = {
  databaseUrl: () => read("DATABASE_URL") ?? read("POSTGRES_URL"),
  apiKey: () => read("MINUTA_API_KEY"),
  dashboardPassword: () => read("DASHBOARD_PASSWORD") ?? read("MINUTA_API_KEY"),

  /** groq (gratis, Whisper) o deepgram (de pago, distingue hablantes). Por defecto: el que tenga clave, Groq primero. */
  transcriptionProvider: (): "groq" | "deepgram" | null => {
    const explicit = read("TRANSCRIPTION_PROVIDER");
    if (explicit === "groq" || explicit === "deepgram") return explicit;
    if (read("GROQ_API_KEY")) return "groq";
    if (read("DEEPGRAM_API_KEY")) return "deepgram";
    return null;
  },
  groqKey: () => read("GROQ_API_KEY"),
  groqUrl: () => (read("GROQ_API_URL") ?? "https://api.groq.com").replace(/\/$/, ""),
  groqModel: () => read("GROQ_MODEL") ?? "whisper-large-v3-turbo",

  deepgramKey: () => read("DEEPGRAM_API_KEY"),
  deepgramUrl: () => (read("DEEPGRAM_API_URL") ?? "https://api.deepgram.com").replace(/\/$/, ""),
  deepgramModel: () => read("DEEPGRAM_MODEL") ?? "nova-3",

  anthropicKey: () => read("ANTHROPIC_API_KEY"),
  anthropicModel: () => read("ANTHROPIC_MODEL") ?? "claude-opus-5-5",

  resendKey: () => read("RESEND_API_KEY"),
  resendUrl: () => (read("RESEND_API_URL") ?? "https://api.resend.com").replace(/\/$/, ""),
  emailFrom: () => read("EMAIL_FROM") ?? "Minuta <onboarding@resend.dev>",
  emailTo: () => read("EMAIL_TO"),

  appUrl: (): string | undefined => {
    const explicit = read("APP_URL");
    if (explicit) return explicit.replace(/\/$/, "");
    const vercel = read("VERCEL_PROJECT_PRODUCTION_URL") ?? read("VERCEL_URL");
    return vercel ? `https://${vercel}` : undefined;
  },
};

/** Qué piezas están configuradas (para la lista de comprobación del panel y /api/health). */
export function configStatus() {
  return {
    database: Boolean(env.databaseUrl()),
    apiKey: Boolean(env.apiKey()),
    transcription: Boolean(env.transcriptionProvider()),
    anthropic: Boolean(env.anthropicKey()),
    resend: Boolean(env.resendKey()),
  };
}
