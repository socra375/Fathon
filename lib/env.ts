/** Lectura centralizada de variables de entorno. */

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Lista ordenada desde una variable «a,b,c» (si falta, el orden por defecto). */
function order<T extends string>(name: string, fallback: T[], head?: string): T[] {
  const raw = read(name);
  const parsed = raw ? (raw.split(/[\s,;]+/).map((x) => x.toLowerCase()).filter(Boolean) as T[]) : fallback;
  if (head && (fallback as string[]).includes(head)) return [head as T, ...parsed.filter((x) => x !== head)];
  return parsed;
}

export type LlmId = "claude" | "gemini" | "openrouter" | "groq";
export type SttId = "groq" | "deepgram";
export type MailId = "resend" | "smtp";

export const env = {
  databaseUrl: () => read("DATABASE_URL") ?? read("POSTGRES_URL"),
  apiKey: () => read("MINUTA_API_KEY"),
  dashboardPassword: () => read("DASHBOARD_PASSWORD") ?? read("MINUTA_API_KEY"),

  /** groq (gratis, Whisper) o deepgram (de pago, distingue hablantes). Por defecto: el que tenga clave, Groq primero. */
  /** Orden de los proveedores de transcripción de voz. TRANSCRIPTION_PROVIDER fija el primero. */
  transcriptionOrder: (): SttId[] => order<SttId>("TRANSCRIPTION_PROVIDERS", ["groq", "deepgram"], read("TRANSCRIPTION_PROVIDER")),
  groqKey: () => read("GROQ_API_KEY"),
  groqUrl: () => (read("GROQ_API_URL") ?? "https://api.groq.com").replace(/\/$/, ""),
  groqModel: () => read("GROQ_MODEL") ?? "whisper-large-v3-turbo",

  deepgramKey: () => read("DEEPGRAM_API_KEY"),
  deepgramUrl: () => (read("DEEPGRAM_API_URL") ?? "https://api.deepgram.com").replace(/\/$/, ""),
  deepgramModel: () => read("DEEPGRAM_MODEL") ?? "nova-3",

  /** claude (de pago, mejor calidad) o groq (gratis). Por defecto: Claude si hay clave; si no, Groq. */
  /** Orden de los proveedores de análisis. ANALYSIS_PROVIDER fija el primero. Claude va primero si hay clave. */
  analysisOrder: (): LlmId[] => order<LlmId>("ANALYSIS_PROVIDERS", ["claude", "gemini", "openrouter", "groq"], read("ANALYSIS_PROVIDER")),
  geminiKey: () => read("GEMINI_API_KEY") ?? read("GOOGLE_API_KEY"),
  geminiUrl: () => (read("GEMINI_API_URL") ?? "https://generativelanguage.googleapis.com").replace(/\/$/, ""),
  geminiModel: () => read("GEMINI_MODEL") ?? "gemini-2.5-flash",
  openrouterKey: () => read("OPENROUTER_API_KEY"),
  openrouterUrl: () => (read("OPENROUTER_API_URL") ?? "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  /** «openrouter/free» elige solo un modelo gratuito que admita lo que se pide. */
  openrouterModel: () => read("OPENROUTER_MODEL") ?? "openrouter/free",
  /** Cuánto texto admite como máximo una petición a cada modelo (tokens de entrada). */
  maxInputTokens: (id: LlmId): number => {
    const override = Number(read(`${id.toUpperCase()}_MAX_INPUT_TOKENS`));
    if (override > 0) return override;
    return { claude: 800_000, gemini: 800_000, openrouter: 24_000, groq: 5_800 }[id];
  },
  groqAnalysisModel: () => read("GROQ_ANALYSIS_MODEL") ?? "openai/gpt-oss-120b",
  /** «chunks» fuerza el análisis por tramos aunque la reunión quepa de una vez (pruebas y depuración). */
  analysisMode: (): "auto" | "chunks" => (read("ANALYSIS_MODE") === "chunks" ? "chunks" : "auto"),
  /** Tokens de transcripción por petición al modelo gratuito (su límite es ~8.000 tokens/min). */
  analysisChunkTokens: () => Number(read("ANALYSIS_CHUNK_TOKENS")) || 3800,
  /** Tiempo de trabajo por invocación antes de guardar el progreso y continuar en otra (Vercel corta a los 300 s). */
  processingBudgetMs: () => Number(read("PROCESSING_BUDGET_MS")) || 240_000,

  anthropicKey: () => read("ANTHROPIC_API_KEY"),
  anthropicModel: () => read("ANTHROPIC_MODEL") ?? "claude-opus-5-5",

  /** Orden de los proveedores de correo. */
  emailOrder: (): MailId[] => order<MailId>("EMAIL_PROVIDERS", ["resend", "smtp"]),
  smtpHost: () => read("SMTP_HOST") ?? "smtp.gmail.com",
  smtpPort: () => Number(read("SMTP_PORT")) || 465,
  smtpUser: () => read("SMTP_USER"),
  smtpPass: () => read("SMTP_PASS")?.replace(/\s+/g, ""), // Gmail muestra la contraseña de aplicación con espacios
  smtpFrom: () => read("SMTP_FROM") ?? (read("SMTP_USER") ? `Minuta <${read("SMTP_USER")}>` : undefined),
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
    transcription: Boolean(env.groqKey() || env.deepgramKey()),
    analysis: Boolean(env.anthropicKey() || env.geminiKey() || env.openrouterKey() || env.groqKey()),
    email: Boolean(env.resendKey() || (env.smtpUser() && env.smtpPass())),
  };
}
