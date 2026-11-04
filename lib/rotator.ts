/**
 * Rotador de proveedores.
 *
 * Una lista ordenada de proveedores de IA (o de correo) que hacen lo mismo. Se usa el primero
 * disponible; si responde que ha alcanzado su límite, se anota hasta cuándo (en la base de datos,
 * para que las reuniones siguientes ni lo intenten) y se pasa al siguiente. Si todos están en
 * pausa, se espera cuando la pausa es corta o se pide continuar más tarde (`RetryLater`).
 *
 * Este módulo no toca la red ni la base de datos: recibe el almacén de pausas, para poder probarlo.
 */
import { Budget, ContinueLater, RetryLater } from "./budget";

/** El proveedor ha alcanzado su límite o no está disponible por un tiempo. */
export class ProviderLimit extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryAfterMs: number,
    readonly kind: "rate" | "quota" | "auth" | "overload",
  ) {
    super(message);
    this.name = "ProviderLimit";
  }
}

/** Este proveedor no sirve para esta petición (p. ej. no cabe), pero no está agotado. */
export class ProviderSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSkip";
  }
}

/** Ningún proveedor pudo completar la petición y no es cuestión de esperar. */
export class AllProvidersFailed extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = "AllProvidersFailed";
  }
}

export interface Cooldown {
  until: number;
  reason: string;
}

export interface CooldownStore {
  all(): Promise<Map<string, Cooldown>>;
  set(key: string, until: number, reason: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/** Almacén en memoria (para pruebas). */
export function memoryStore(initial: Record<string, Cooldown> = {}): CooldownStore {
  const m = new Map(Object.entries(initial));
  return {
    async all() {
      return new Map(m);
    },
    async set(key, until, reason) {
      m.set(key, { until, reason });
    },
    async clear(key) {
      m.delete(key);
    },
  };
}

// ---------------------------------------------------------------- errores HTTP → pausas

const MIN_MS = 1000;
const MAX_MS = 6 * 3_600_000;

/** "7.66s" | "1m2.5s" | "350ms" | "2h" → milisegundos. */
export function parseDuration(v: string | null | undefined): number {
  if (!v) return 0;
  let ms = 0;
  for (const [, n, unit] of v.matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
    const x = Number(n);
    ms += unit === "h" ? x * 3_600_000 : unit === "m" ? x * 60_000 : unit === "s" ? x * 1000 : x;
  }
  return Math.ceil(ms);
}

/** Cuánto esperar según las cabeceras y el cuerpo del error (cada proveedor lo dice a su manera). */
export function retryAfterMs(headers: Headers | Record<string, string>, body: string, now = Date.now()): number {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
    return k ? headers[k] : null;
  };
  const candidates: number[] = [];

  const ra = get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) candidates.push(secs * 1000);
    else {
      const date = Date.parse(ra);
      if (!Number.isNaN(date)) candidates.push(date - now);
    }
  }
  for (const h of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset"]) {
    const v = get(h);
    if (!v) continue;
    if (/^\d{10,}$/.test(v)) candidates.push(Number(v) > 1e12 ? Number(v) - now : Number(v) * 1000 - now); // época
    else candidates.push(parseDuration(v));
  }
  // Gemini: "retryDelay": "37s" y "Please retry in 37.2s"
  const delay = /"retryDelay"\s*:\s*"([^"]+)"/.exec(body);
  if (delay) candidates.push(parseDuration(delay[1]));
  const retryIn = /retry in ([\d.]+)\s*(ms|s)/i.exec(body);
  if (retryIn) candidates.push(parseDuration(retryIn[1] + retryIn[2]));
  // OpenRouter: metadata.headers["X-RateLimit-Reset"] = época en ms
  const reset = /"X-RateLimit-Reset"\s*:\s*"?(\d{10,})/i.exec(body);
  if (reset) candidates.push(Number(reset[1]) - now);

  const valid = candidates.filter((c) => Number.isFinite(c) && c > 0);
  return valid.length ? Math.max(...valid) : 0;
}

/**
 * Convierte una respuesta HTTP de error en `ProviderLimit` (hay que pausar el proveedor),
 * `ProviderSkip` (no cabe) o un `Error` normal (fallo de esta petición, no del proveedor).
 */
export function classifyHttpError(provider: string, status: number, headers: Headers | Record<string, string>, body: string): Error {
  const snippet = body.replace(/\s+/g, " ").slice(0, 240);
  const waited = retryAfterMs(headers, body);
  const daily = /per day|daily|\bRPD\b|quota exceeded|exceeded your current quota|insufficient[_ ]quota/i.test(body);

  if (status === 429 || /RESOURCE_EXHAUSTED/.test(body)) {
    const ms = waited || (daily ? 3_600_000 : 60_000);
    const kind = daily && waited < 600_000 ? "quota" : "rate";
    return new ProviderLimit(`${provider} alcanzó su límite (${snippet})`, provider, clamp(ms), kind);
  }
  if (status === 402) {
    return new ProviderLimit(`${provider}: sin créditos (${snippet})`, provider, 6 * 3_600_000, "quota");
  }
  if (status === 401 || status === 403) {
    return new ProviderLimit(`${provider}: clave no válida o sin permiso (${snippet})`, provider, 6 * 3_600_000, "auth");
  }
  if (status === 408 || status === 425 || status >= 500) {
    return new ProviderLimit(`${provider}: no disponible, HTTP ${status}`, provider, clamp(waited || 120_000), "overload");
  }
  if (status === 413) return new ProviderSkip(`${provider}: la petición es demasiado grande`);
  return new Error(`${provider} respondió ${status}: ${snippet}`);
}

function clamp(ms: number): number {
  return Math.min(MAX_MS, Math.max(MIN_MS, ms));
}

// ---------------------------------------------------------------- rotación

export interface Candidate<T> {
  id: string;
  label?: string;
  run: () => Promise<T>;
}

export interface RotateOptions {
  /** Prefijo de las claves en el almacén: «analysis», «stt», «email». */
  namespace: string;
  store: CooldownStore;
  /** Si se indica, se espera dentro de la invocación cuando la pausa más corta cabe en el presupuesto. */
  budget?: Budget;
  now?: () => number;
}

export interface Rotated<T> {
  provider: string;
  value: T;
  /** Qué ocurrió con los proveedores anteriores (para el registro). */
  skipped: string[];
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + " UTC";
}

/** Prueba los candidatos en orden hasta que uno responda. */
export async function rotate<T>(candidates: Candidate<T>[], opts: RotateOptions): Promise<Rotated<T>> {
  const now = opts.now ?? Date.now;
  if (candidates.length === 0) throw new AllProvidersFailed("No hay ningún proveedor configurado.", []);

  for (let pass = 0; pass < 4; pass++) {
    const blocked = await opts.store.all();
    const problems: string[] = [];
    const skipped: string[] = [];
    let earliest = Number.POSITIVE_INFINITY;
    let hardFailures = 0;

    for (const c of candidates) {
      const key = `${opts.namespace}:${c.id}`;
      const b = blocked.get(key);
      if (b && b.until > now()) {
        earliest = Math.min(earliest, b.until);
        problems.push(`${c.label ?? c.id}: en pausa hasta ${hhmm(b.until)}`);
        skipped.push(c.id);
        continue;
      }
      try {
        const value = await c.run();
        if (b) await opts.store.clear(key);
        return { provider: c.id, value, skipped };
      } catch (err) {
        if (err instanceof ContinueLater) throw err;
        if (err instanceof ProviderLimit) {
          const until = now() + err.retryAfterMs;
          await opts.store.set(key, until, err.message.slice(0, 300));
          earliest = Math.min(earliest, until);
          problems.push(`${c.label ?? c.id}: ${err.message}`);
          skipped.push(c.id);
          continue;
        }
        hardFailures += 1;
        problems.push(`${c.label ?? c.id}: ${err instanceof Error ? err.message : String(err)}`);
        skipped.push(c.id);
      }
    }

    if (!Number.isFinite(earliest)) {
      throw new AllProvidersFailed(`Ningún proveedor pudo completar la petición. ${problems.join(" · ")}`, problems);
    }

    // Todos fallaron o están en pausa. Si la pausa más corta cabe en la invocación, se espera aquí.
    const wait = earliest - now();
    if (opts.budget && wait + 3000 <= opts.budget.remainingMs() - 15_000) {
      await new Promise((r) => setTimeout(r, Math.max(0, wait) + 250));
      continue;
    }
    // Si algún proveedor falló "de verdad" (no por límite) y los demás solo esperan, se sigue esperando.
    void hardFailures;
    throw new RetryLater(new Date(earliest), `Todos los proveedores están en pausa. ${problems.join(" · ")}`);
  }
  throw new AllProvidersFailed("Se agotaron los reintentos de rotación.", []);
}
