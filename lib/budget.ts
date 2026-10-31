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

  /** Espera `ms` (p. ej. a que se renueve el límite por minuto) si cabe en el presupuesto. */
  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (Date.now() + ms > this.deadline) throw new ContinueLater("Hay que esperar al límite por minuto del plan gratuito");
    await new Promise((r) => setTimeout(r, ms));
  }
}
