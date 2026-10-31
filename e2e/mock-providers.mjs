// Servidor que imita las APIs de Deepgram, Anthropic (Messages, streaming SSE) y Resend.
// Guarda lo que recibe para que la prueba E2E pueda verificarlo.
import http from "node:http";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PORT = Number(process.env.MOCK_PORT || 4010);
const OUT = process.env.MOCK_OUT || path.resolve("e2e/.tmp");
const captured = { deepgram: [], anthropic: [], resend: [] };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Los WebM de MediaRecorder no llevan duración en la cabecera: se decodifica entero para medirla.
function probeDuration(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  const times = [...(r.stderr || "").matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!times.length) return 0;
  const [, h, m, s] = times[times.length - 1];
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "request-id": "req_mock" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await readBody(req);

  if (req.method === "GET" && url.pathname === "/__captured") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(captured));
    return;
  }

  // ---------------- Deepgram
  if (req.method === "POST" && url.pathname === "/deepgram/v1/listen") {
    const file = path.join(OUT, `received-audio-${captured.deepgram.length}.webm`);
    writeFileSync(file, body);
    const duration = probeDuration(file);
    captured.deepgram.push({
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      query: Object.fromEntries(url.searchParams),
      bytes: body.length,
      file,
      duration,
    });
    const d = Math.max(duration, 12);
    const utterances = [
      { start: 0.5, end: d * 0.3, speaker: 0, transcript: "Buenos días a todos. Hoy revisamos el lanzamiento de la versión dos y el presupuesto de marketing." },
      { start: d * 0.3 + 0.2, end: d * 0.55, speaker: 1, transcript: "Gracias, Marta. Propongo retrasar el lanzamiento una semana porque faltan las pruebas de pago." },
      { start: d * 0.55 + 0.2, end: d * 0.8, speaker: 0, transcript: "De acuerdo, lo movemos al día catorce. Carlos, ¿puedes preparar el plan de pruebas para el viernes?" },
      { start: d * 0.8 + 0.2, end: d - 0.2, speaker: 1, transcript: "Sí, lo tendré el viernes. Queda pendiente decidir el presupuesto de anuncios." },
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        metadata: { duration: d, channels: 1 },
        results: {
          channels: [{ detected_language: "es", alternatives: [{ transcript: utterances.map((u) => u.transcript).join(" ") }] }],
          utterances,
        },
      }),
    );
    return;
  }

  // ---------------- Anthropic Messages (streaming)
  if (req.method === "POST" && url.pathname === "/anthropic/v1/messages") {
    const reqJson = JSON.parse(body.toString("utf8"));
    captured.anthropic.push({
      auth: req.headers.authorization || req.headers["x-api-key"],
      beta: req.headers["anthropic-beta"],
      model: reqJson.model,
      stream: reqJson.stream,
      fallbacks: reqJson.fallbacks,
      thinking: reqJson.thinking,
      effort: reqJson.output_config?.effort,
      hasSchema: reqJson.output_config?.format?.type === "json_schema",
      maxTokens: reqJson.max_tokens,
      prompt: reqJson.messages?.[0]?.content,
      system: typeof reqJson.system === "string" ? reqJson.system.slice(0, 80) : null,
    });
    const prompt = String(reqJson.messages?.[0]?.content ?? "");
    const lines = (prompt.match(/\[\d\d:\d\d\]/g) || []).length;
    const analysis = {
      title: "Lanzamiento de la versión 2 y presupuesto",
      summary: `Se revisó el lanzamiento de la versión 2 (${lines} intervenciones). Se acordó retrasarlo una semana, al día 14, para completar las pruebas de pago. Carlos prepara el plan de pruebas para el viernes. Queda pendiente el presupuesto de anuncios.`,
      key_points: ["El lanzamiento pasa al día 14.", "Faltan las pruebas de pago."],
      topics: [
        { title: "Fecha de lanzamiento", start: "00:00", summary: "Se propone retrasar una semana." },
        { title: "Plan de pruebas", start: "00:20", summary: "Carlos se encarga." },
      ],
      decisions: ["Retrasar el lanzamiento al día 14."],
      action_items: [{ owner: "Carlos", task: "Preparar el plan de pruebas de pago", due: "viernes" }],
      open_questions: ["¿Cuál será el presupuesto de anuncios?"],
      risks: ["Las pruebas de pago podrían retrasar más el lanzamiento."],
      speakers: [
        { label: "Hablante 1", likely_name: "Marta", contribution: "Dirige la reunión y fija la fecha." },
        { label: "Hablante 2", likely_name: "Carlos", contribution: "Propone el retraso y asume el plan de pruebas." },
      ],
      sentiment: { overall: "positive", explanation: "Reunión colaborativa con acuerdos rápidos." },
      follow_up_email: {
        subject: "Resumen: lanzamiento v2",
        body: "Hola a todos,\n\nAcordamos mover el lanzamiento al día 14. Carlos enviará el plan de pruebas el viernes.\n\nUn saludo.",
      },
    };
    const text = JSON.stringify(analysis);
    const parts = text.match(/.{1,200}/gs) || [text];
    const msg = {
      id: "msg_mock_1",
      type: "message",
      role: "assistant",
      model: reqJson.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 1 },
    };
    sse(res, [
      ["message_start", { type: "message_start", message: msg }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ...parts.map((p) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }]),
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 600 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    return;
  }

  // ---------------- Resend
  if (req.method === "POST" && url.pathname === "/resend/emails") {
    const j = JSON.parse(body.toString("utf8"));
    const id = `email_mock_${captured.resend.length + 1}`;
    writeFileSync(path.join(OUT, `email-${captured.resend.length}.html`), j.html || "");
    captured.resend.push({
      auth: req.headers.authorization,
      from: j.from,
      to: j.to,
      subject: j.subject,
      htmlBytes: (j.html || "").length,
      text: j.text,
      attachments: (j.attachments || []).map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "base64").toString("utf8"),
      })),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path: url.pathname }));
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock providers on :${PORT}`));
