import Link from "next/link";

export default function Home() {
  return (
    <>
      <header className="wrap nav">
        <Link href="/" className="logo">
          <img src="/logo.svg" alt="" />
          Minuta
        </Link>
        <nav className="nav-links">
          <a href="#como-funciona" className="btn ghost hide-sm">
            Cómo funciona
          </a>
          <Link href="/dashboard" className="btn secondary">
            Entrar
          </Link>
        </nav>
      </header>

      <main>
        <section className="wrap hero">
          <div>
            <span className="eyebrow">Notas de reuniones con IA</span>
            <h1>Termina la reunión. El resumen ya está en tu correo.</h1>
            <p className="lead">
              Minuta graba tus reuniones de Google Meet, Microsoft Teams y Zoom desde el navegador, las transcribe
              separando tu voz de la de los demás y te envía un informe con resumen, decisiones, tareas y análisis de la
              conversación.
            </p>
            <div className="cta">
              <Link href="/dashboard" className="btn lg">
                Ir a mi panel
              </Link>
              <a href="#como-funciona" className="btn secondary lg">
                Ver cómo funciona
              </a>
            </div>
            <p className="platforms">Google Meet · Microsoft Teams (web) · Zoom (cliente web)</p>
          </div>

          <div className="mock" aria-label="Ejemplo de informe">
            <div className="mhead">
              <span>Google Meet · 42:18</span>
              <span>Informe de Minuta</span>
            </div>
            <h3>Revisión del lanzamiento de noviembre</h3>
            <p className="sum">
              Se acordó retrasar el lanzamiento una semana para cerrar las pruebas de pago. Laura prepara el plan de
              comunicación y Diego revisa los precios con ventas antes del jueves.
            </p>
            <strong style={{ fontSize: 14 }}>Tareas</strong>
            <ul>
              <li>Laura — plan de comunicación (lunes)</li>
              <li>Diego — validar precios con ventas (jueves)</li>
              <li>Sin asignar — revisar la página de preguntas frecuentes</li>
            </ul>
            <div style={{ marginTop: 14, fontSize: 13 }}>
              <div>Tú · 46%</div>
              <div className="bar">
                <span style={{ width: "46%" }} />
              </div>
              <div>Otros participantes · 54%</div>
              <div className="bar">
                <span style={{ width: "54%" }} />
              </div>
            </div>
          </div>
        </section>

        <section className="wrap section" id="como-funciona">
          <h2>Cómo funciona</h2>
          <div className="grid3">
            <div className="feature">
              <div className="num">1</div>
              <h3>Pulsa «Grabar»</h3>
              <p>
                Al entrar en la reunión aparece el botón de Minuta. Eliges la pestaña y se graba el audio de todos,
                incluida tu voz.
              </p>
            </div>
            <div className="feature">
              <div className="num">2</div>
              <h3>Termina y envía</h3>
              <p>
                Al acabar pulsas «Terminar y enviar». Tu voz y la de los demás se graban por separado y se
                transcriben gratis, en español, inglés o mezclados.
              </p>
            </div>
            <div className="feature">
              <div className="num">3</div>
              <h3>Recibe el informe</h3>
              <p>
                En unos minutos llega a tu correo el resumen, las decisiones, las tareas con responsable, los riesgos y
                un correo de seguimiento listo para enviar.
              </p>
            </div>
          </div>
        </section>

        <section className="wrap section">
          <h2>Qué incluye cada informe</h2>
          <div className="grid3">
            <div className="feature">
              <h3>Resumen y temas</h3>
              <p>Resumen ejecutivo y los temas tratados con la marca de tiempo en que empezó cada uno.</p>
            </div>
            <div className="feature">
              <h3>Decisiones y tareas</h3>
              <p>Solo los acuerdos explícitos, y cada tarea con su responsable y plazo cuando se mencionan.</p>
            </div>
            <div className="feature">
              <h3>Análisis de la conversación</h3>
              <p>Tiempo de palabra medido por persona, tono, preguntas sin respuesta, objeciones y riesgos.</p>
            </div>
          </div>
        </section>

        <section className="wrap section">
          <p className="note">
            <strong>Graba con permiso.</strong> En muchos países es obligatorio avisar a todos los participantes antes
            de grabar. Minuta incluye un botón para copiar un aviso y pegarlo en el chat de la reunión. El audio se borra
            del servidor en cuanto se genera el informe.
          </p>
        </section>
      </main>

      <footer className="wrap">Minuta · Transcripción con Whisper · Análisis con Claude</footer>
    </>
  );
}
