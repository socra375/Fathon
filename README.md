# Minuta

Transcriptor y analista de reuniones con IA para **Google Meet**, **Microsoft Teams (web)** y **Zoom (cliente web)**.
Pulsas «Grabar esta reunión» y, al terminar, te llega un correo con el resumen, las decisiones, las tareas, el
análisis de la conversación y la transcripción completa.

```
Extensión de Chrome ──► Servidor Next.js (Vercel) ──► Deepgram ──► Claude ──► Resend ──► tu correo
 botón en la reunión     guarda audio en Postgres      voz→texto     análisis     correo
 graba pestaña + micro   (Neon) y coordina             + hablantes   estructurado
```

## Cómo funciona

1. **Extensión (Manifest V3, `extension/`)**: inserta un botón flotante en Meet, Teams y Zoom web. Al pulsarlo pide
   compartir la pestaña con su audio (`getDisplayMedia`) y mezcla tu micrófono con `AudioContext`. `MediaRecorder` genera
   fragmentos WebM/Opus de 15 s que el service worker sube al servidor con reintentos.
2. **Servidor (`app/api`)**: guarda los fragmentos en Postgres. Al terminar (o al cerrarse la pestaña) une el audio,
   lo transcribe con Deepgram (con diarización y multilingüe), lo analiza con Claude (salida JSON con esquema estricto) y
   envía el informe con Resend. El proceso se reanuda en el paso en que falló y el audio se borra al acabar.
3. **Panel (`app/dashboard`)**: historial, informe de cada reunión, transcripción, reintentar o reenviar, ajustes y
   descarga de la extensión ya configurada.

## Variables de entorno

Consulta `.env.example`. Las obligatorias son `DATABASE_URL`, `MINUTA_API_KEY`, `DEEPGRAM_API_KEY`,
`ANTHROPIC_API_KEY` y `RESEND_API_KEY`. El esquema de la base de datos se crea solo la primera vez.

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

La prueba E2E levanta un Postgres local, simula Deepgram, Anthropic y Resend, descarga la extensión desde el
panel, la carga en Chromium, graba una reunión de Meet simulada y comprueba que el audio de la pestaña y del
micrófono llega mezclado, que se transcribe, se analiza y se envía el correo, y que el panel lo muestra.

## Límites conocidos

- Solo funciona en el **navegador** (Chrome, Edge u otros basados en Chromium). Las apps de escritorio de Zoom y
  Teams no se pueden grabar desde una extensión.
- Chrome muestra su diálogo para compartir la pestaña: hay que elegir «Esta pestaña» con el audio activado.
- Los hablantes aparecen como «Hablante 1, 2…». La IA solo propone nombres cuando se deducen de la conversación.
- Grabar sin el consentimiento de los participantes es ilegal en muchas jurisdicciones. Usa el aviso incluido.
