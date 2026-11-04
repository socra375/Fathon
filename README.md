# Minuta

Transcriptor y analista de reuniones con IA para **Google Meet**, **Microsoft Teams (web)** y **Zoom (cliente web)**.
Pulsas «Grabar esta reunión» y, al terminar, te llega un correo con el resumen, las decisiones, las tareas, el
análisis de la conversación y la transcripción completa.

```
Extensión de Chrome ──► Servidor Next.js (Vercel) ──► voz→texto ──► análisis con IA ──► correo
 botón en la reunión     guarda audio en Postgres      Groq ⇄ Deepgram   Claude ⇄ Gemini ⇄    Resend ⇄ SMTP
 2 pistas: tú / demás     (Neon) y coordina                              OpenRouter ⇄ Groq    (a cada destinatario)
```

Cada paso tiene **varios proveedores que rotan solos**: si uno alcanza su límite gratuito se pasa al siguiente.

## Cómo funciona

1. **Extensión (Manifest V3, `extension/`)**: inserta un botón flotante en Meet, Teams y Zoom web. Al pulsarlo pide
   compartir la pestaña con su audio (`getDisplayMedia`) y graba por separado tu micrófono. `MediaRecorder` genera
   fragmentos WebM/Opus de 15 s por pista que el service worker sube al servidor con reintentos.
2. **Servidor (`app/api`)**: guarda los fragmentos en Postgres. Al terminar (o al cerrarse la pestaña) une el audio,
   lo transcribe por pista (`lib/transcribe.ts`), lo analiza (`lib/analyze-rotating.ts`) y envía el informe (`lib/mailer.ts`).
   Cada paso usa el rotador `lib/rotator.ts`: prueba los proveedores en orden, anota en la tabla `provider_state` cuándo
   vuelve cada uno que alcanzó su límite (leyendo `Retry-After` y similares) y pasa al siguiente. Si todos están en pausa,
   la reunión espera sola (hasta 2 h 30 min) y continúa; el progreso se guarda, así que nada se repite.
   El análisis se hace de una vez con Gemini/Claude y, si no caben o están en pausa, por tramos con cualquier proveedor.
3. **Panel (`app/dashboard`)**: estado de cada proveedor (disponible, sin clave o en pausa y cuándo vuelve), historial,
   informe de cada reunión, transcripción, reintentar, reenviar (a todos o solo a los que fallaron), ajustes y descarga
   de la extensión ya configurada.

## Variables de entorno

Consulta `.env.example`. Obligatorias: `DATABASE_URL`, `MINUTA_API_KEY`, una clave de transcripción (`GROQ_API_KEY`
gratis, y opcionalmente `DEEPGRAM_API_KEY` de respaldo), una de análisis (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`GROQ_API_KEY` o `ANTHROPIC_API_KEY`) y una de correo (`RESEND_API_KEY` o `SMTP_USER` + `SMTP_PASS`). Cuantas más claves
pongas, más difícil es quedarse sin cupo. El esquema de la base de datos se crea solo la primera vez.

## Desarrollo

```bash
npm install
npm run dev
```

## Pruebas

```bash
npm test               # pruebas unitarias (vitest)
npm run build
npm run e2e            # punta a punta: Postgres + servidor + Chromium con la extensión
```

La prueba E2E levanta un Postgres local, simula Groq, Deepgram, Gemini, OpenRouter, Anthropic, Resend y un servidor
SMTP, descarga la extensión desde el panel, la carga en Chromium, graba una reunión de Meet simulada y comprueba que
las dos pistas se transcriben, se analizan y se envían. Después provoca límites (429 de Whisper y de Gemini, Resend
restringido, esperas largas) y comprueba que se rota al siguiente proveedor, que las pausas se recuerdan y que el
reintento solo llega a quien falló.

## Límites conocidos

- Solo funciona en el **navegador** (Chrome, Edge u otros basados en Chromium). Las apps de escritorio de Zoom y
  Teams no se pueden grabar desde una extensión.
- Chrome muestra su diálogo para compartir la pestaña: hay que elegir «Esta pestaña» con el audio activado.
- Con Groq (gratis) la transcripción distingue «Tú» (tu micrófono) de «Otros participantes» (el audio de la reunión),
  pero no separa entre sí a los demás. Con Deepgram se distingue a cada participante.
- **Transcripción**: Gemini y OpenRouter no aceptan el audio WebM que graba el navegador, así que solo rotan Groq y
  Deepgram (este último con crédito inicial, no gratis para siempre). Si ambos se agotan, la reunión espera.
  Plan gratuito de Groq: ≈ 2 h de audio por hora y 8 h al día; como se transcriben dos pistas, una reunión de 73 min
  consume ≈ 2,4 h de ese cupo.
- **Análisis**: con Gemini se analiza la reunión entera de una vez. Los límites gratuitos de Gemini y OpenRouter los
  fija cada proveedor y cambian; la app lee el aviso de «límite alcanzado» y rota, no los da por supuestos.
  Con Groq (≈ 8.000 tokens/min) se analiza por tramos y tarda más.
- **Correo**: Resend sin dominio verificado solo envía a tu propia cuenta; para varios destinatarios añade SMTP
  (Gmail con contraseña de aplicación) o verifica un dominio. Si alguien no recibe el informe, el panel lo indica y
  permite «Reintentar solo a los que fallaron».
- Grabar sin el consentimiento de los participantes es ilegal en muchas jurisdicciones. Usa el aviso incluido.
