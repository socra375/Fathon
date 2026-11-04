/**
 * Presupuesto de tiempo de una invocación del servidor.
 *
 * Vercel corta una función a los 300 s. Los planes gratuitos de Groq limitan los tokens por
 * minuto, así que una reunión larga puede necesitar más tiempo: cuando se agota el presupuesto,
 * el proceso guarda su progreso, lanza `ContinueLater` y la canalización se vuelve a invocar
 * a sí misma para seguir donde se quedó.
 */
export class ContinueLater extends Error {
  constructor(reason = "Se agotó el tiempo de esta ejecución") {
    super(reason);
    this.name = "ContinueLater";
  }
}

/** Hay que esperar hasta `at` (un proveedor de IA está en pausa): la ejecución continúa entonces. */
export class RetryLater extends ContinueLater {
  constructor(
    readonly at: Date,
    message = "Los proveedores de IA están en pausa",
  ) {
    super(message);
    this.name = "RetryLater";
  }
}

export class Budget {
  private progressed = false;

  constructor(readonly deadline: number) {}

  static fromNow(ms: number): Budget {
    return new Budget(Date.now() + ms);
  }

  remainingMs(): number {
    return this.deadline - Date.now();
  }

  /** Marca que esta invocación ya completó trabajo útil (y lo guardó). */
  markProgress(): void {
    this.progressed = true;
  }

  /**
   * Antes de empezar un paso que tarda `expectedMs`: si no cabe y ya se avanzó algo,
   * es mejor continuar en otra invocación. Si aún no se avanzó nada se intenta igualmente,
   * para no entrar nunca en un bucle sin progreso.
   */
  ensure(expectedMs: number): void {
    if (this.progressed && Date.now() + expectedMs > this.deadline) throw new ContinueLater();
  }

  /**
   * Duerme hasta `ms`, pero sin pasarse del presupuesto (deja 15 s para guardar y relanzar).
   * Devuelve los milisegundos que aún quedan por esperar.
   */
  async sleepUpTo(ms: number): Promise<number> {
    const can = Math.max(0, Math.min(ms, this.remainingMs() - 15_000));
    if (can > 0) await new Promise((r) => setTimeout(r, can));
    return Math.max(0, ms - can);
  }

  /** Espera `ms` (p. ej. a que se renueve el límite por minuto) si cabe en el presupuesto. */
  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (Date.now() + ms > this.deadline) throw new ContinueLater("Hay que esperar al límite por minuto del plan gratuito");
    await new Promise((r) => setTimeout(r, ms));
  }
}
