// Prueba de punta a punta de Minuta.
//
//  Postgres real  ←  servidor Next.js (build de producción)  →  Deepgram / Anthropic / Resend simulados
//                          ↑
//  Chromium real con la extensión descargada del panel, en una "reunión de Google Meet" simulada
//  que reproduce audio (440 Hz) mientras el micrófono falso emite 880 Hz.
//
// Uso: npm run build && npm run e2e
import { spawn, execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const JSZip = require("jszip");
const { Client } = require("pg");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TMP = path.join(ROOT, "e2e", ".tmp");
const PG_BIN = "/usr/lib/postgresql/16/bin";
const PG_PORT = 54329;
const APP_PORT = 3100;
const MOCK_PORT = 4010;
const APP = `http://127.0.0.1:${APP_PORT}`;
const API_KEY = "e2e-" + "x".repeat(40);
const PASSWORD = "contraseña-e2e";
const EMAIL_TO = "destinatario@example.com";
const RECORD_SECONDS = Number(process.env.E2E_RECORD_SECONDS || 40);
const DATABASE_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`;

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    log("✓", name);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    log("✗", name, "—", err.message);
  }
}

async function waitFor(fn, { timeout = 60000, interval = 500, label = "condición" } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timeout esperando ${label}${last ? `: ${last.message}` : ""}`);
}

function startProc(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const tag = `[${name}]`;
  p.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(`${tag} ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`${tag} ${d}`));
  children.push(p);
  return p;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  try {
    execFileSync("runuser", ["-u", "postgres", "--", `${PG_BIN}/pg_ctl`, "-D", path.join(TMP, "pg"), "-m", "fast", "stop"], { stdio: "ignore" });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// ------------------------------------------------------------------ preparación
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

log("generando audio de prueba");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=180", "-ar", "48000", "-ac", "1", path.join(TMP, "tab.wav")]);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=1500:duration=180", "-ar", "48000", "-ac", "1", path.join(TMP, "mic.wav")]);

log("iniciando Postgres");
const pgDir = path.join(TMP, "pg");
mkdirSync(pgDir);
execSync(`chown postgres:postgres ${pgDir} && chmod 700 ${pgDir}`);
execFileSync("runuser", ["-u", "postgres", "--", `${PG_BIN}/initdb`, "-D", pgDir, "-A", "trust", "-U", "postgres"], { stdio: "ignore" });
execFileSync(
  "runuser",
  ["-u", "postgres", "--", `${PG_BIN}/pg_ctl`, "-D", pgDir, "-l", path.join(pgDir, "log"), "-o", `-p ${PG_PORT} -k ${pgDir} -c listen_addresses=127.0.0.1`, "-w", "start"],
  { stdio: "ignore" },
);

log("iniciando proveedores simulados");
startProc("mock", process.execPath, [path.join(ROOT, "e2e", "mock-providers.mjs")], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_OUT: TMP },
});

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) throw new Error("Falta el build: ejecuta `npm run build` antes.");
log("iniciando Minuta (next start)");
const appEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  PORT: String(APP_PORT),
  DATABASE_URL,
  MINUTA_API_KEY: API_KEY,
  DASHBOARD_PASSWORD: PASSWORD,
  APP_URL: APP,
  EMAIL_TO,
  EMAIL_FROM: "Minuta <onboarding@resend.dev>",
  DEEPGRAM_API_KEY: "test-deepgram",
  DEEPGRAM_API_URL: `http://127.0.0.1:${MOCK_PORT}/deepgram`,
  ANTHROPIC_API_KEY: "test-anthropic",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
  RESEND_API_KEY: "test-resend",
  RESEND_API_URL: `http://127.0.0.1:${MOCK_PORT}/resend`,
};
startProc("next", path.join(ROOT, "node_modules", ".bin", "next"), ["start", "-p", String(APP_PORT), "-H", "127.0.0.1"], { cwd: ROOT, env: appEnv });
await waitFor(async () => (await fetch(`${APP}/api/health`)).ok, { label: "servidor Next", timeout: 60000 });

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

// ------------------------------------------------------------------ 1. API básica
const health = await (await fetch(`${APP}/api/health`)).json();
check("health: listo con todo configurado", () => {
  assert.equal(health.ready, true, JSON.stringify(health));
  assert.equal(health.db, true);
});
{
  const r = await fetch(`${APP}/api/sessions`, { method: "POST", body: "{}" });
  check("POST /api/sessions sin clave → 401", () => assert.equal(r.status, 401));
  const pre = await fetch(`${APP}/api/sessions`, { method: "OPTIONS", headers: { Origin: "chrome-extension://abc", "Access-Control-Request-Method": "POST" } });
  check("CORS preflight para la extensión", () => {
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  });
  const unauthDash = await fetch(`${APP}/dashboard`, { redirect: "manual" });
  check("panel sin sesión redirige a /login", () => assert.match(unauthDash.headers.get("location") || "", /\/login/));
  const unauthZip = await fetch(`${APP}/api/extension`, { redirect: "manual" });
  check("descarga de extensión sin sesión no entrega la clave", () => assert.equal(unauthZip.status, 303));
}

// ------------------------------------------------------------------ 2. Panel: login + descargar extensión
log("abriendo panel");
const plain = await chromium.launch();
const pctx = await plain.newContext({ viewport: { width: 1280, height: 900 } });
const panel = await pctx.newPage();
await panel.goto(`${APP}/`);
await panel.screenshot({ path: path.join(TMP, "01-landing.png"), fullPage: true });
await panel.goto(`${APP}/login`);
await panel.fill("#password", "incorrecta");
await panel.click("button[type=submit]");
await panel.waitForURL(/error=1/);
await panel.fill("#password", PASSWORD);
await panel.click("button[type=submit]");
await panel.waitForURL(`${APP}/dashboard`);
await panel.screenshot({ path: path.join(TMP, "02-dashboard-empty.png"), fullPage: true });
const zipRes = await panel.request.get(`${APP}/api/extension`);
check("descarga de la extensión (zip)", () => {
  assert.equal(zipRes.status(), 200);
  assert.equal(zipRes.headers()["content-type"], "application/zip");
});
const zip = await JSZip.loadAsync(await zipRes.body());
const extDir = path.join(TMP, "ext");
for (const [name, file] of Object.entries(zip.files)) {
  if (file.dir) continue;
  const dest = path.join(extDir, name);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, await file.async("nodebuffer"));
}
const extRoot = path.join(extDir, "minuta-extension");
const configJs = await zip.file("minuta-extension/config.js").async("string");
const manifest = JSON.parse(await zip.file("minuta-extension/manifest.json").async("string"));
check("la extensión trae servidor y clave configurados", () => {
  assert.ok(configJs.includes(APP));
  assert.ok(configJs.includes(API_KEY));
  assert.deepEqual(manifest.host_permissions, [`${APP}/*`]);
});

// ------------------------------------------------------------------ 3. Grabar una reunión
log("lanzando Chromium con la extensión");
const MEETING_HTML = `<!doctype html><html><head><title>Revisión semanal - Google Meet</title>
<style>body{margin:0;background:#202124;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh}</style></head>
<body><div><h1>Reunión simulada</h1><p>Participantes: Marta, Carlos</p>
<audio id="a" src="/__tab.wav" autoplay loop></audio></div></body></html>`;

/**
 * Chromium con la extensión. Con fakeMic se simula un micrófono (1500 Hz). Ojo: el parámetro
 * --use-fake-device-for-media-stream altera el audio de la pestaña en Chromium (duplica el tono),
 * por eso la fidelidad del audio de la pestaña se verifica en un navegador sin dispositivos simulados.
 */
async function launchWithExtension(name, { fakeMic }) {
  const c = await chromium.launchPersistentContext(path.join(TMP, `profile-${name}`), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    timezoneId: "America/Mexico_City",
    // Playwright silencia el audio por defecto; entonces la captura de pestaña solo recibe silencio.
    ignoreDefaultArgs: ["--mute-audio"],
    args: [
      `--disable-extensions-except=${extRoot}`,
      `--load-extension=${extRoot}`,
      "--auto-accept-this-tab-capture",
      ...(fakeMic ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.join(TMP, "mic.wav")}`] : []),
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  await c.grantPermissions(["microphone"], { origin: "https://meet.google.com" });
  await c.route("https://meet.google.com/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/__tab.wav") return route.fulfill({ path: path.join(TMP, "tab.wav"), contentType: "audio/wav" });
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: MEETING_HTML });
  });
  return c;
}
const ctx = await launchWithExtension("a", { fakeMic: true });

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const extId = new URL(sw.url()).host;
log("extensión cargada", extId);

// Popup: estado de conexión
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForSelector("text=Conectado y listo", { timeout: 15000 }).catch(() => {});
const popupText = await popup.textContent("#status");
check("popup: «Conectado y listo»", () => assert.match(popupText || "", /Conectado y listo/));
await popup.screenshot({ path: path.join(TMP, "03-popup.png") });
await popup.close();

// Página que no es una reunión: no debe mostrar el botón
const lobby = await ctx.newPage();
await lobby.goto("https://meet.google.com/landing");
await sleep(2500);
const lobbyHasButton = await lobby.locator("#minuta-root").count();
check("sin botón en meet.google.com/landing", () => assert.equal(lobbyHasButton, 0));
await lobby.close();

const meet = await ctx.newPage();
meet.on("console", (m) => process.env.E2E_VERBOSE && console.log("[page]", m.text()));
await meet.goto("https://meet.google.com/abc-defg-hij");
await meet.locator("#start").waitFor({ timeout: 15000 });
await meet.screenshot({ path: path.join(TMP, "04-meeting-idle.png") });
await meet.evaluate(() => document.getElementById("a").play());
await meet.locator("#start").click();
await meet.locator("#stop").waitFor({ timeout: 20000 });
log(`grabando ${RECORD_SECONDS}s…`);
await sleep(3000);
await meet.screenshot({ path: path.join(TMP, "05-meeting-recording.png") });
await sleep(RECORD_SECONDS * 1000 - 3000);

const [{ id: meetingId }] = (await db.query("SELECT id FROM meetings ORDER BY created_at DESC LIMIT 1")).rows;
const midChunks = (await db.query("SELECT count(*)::int AS n FROM audio_chunks WHERE meeting_id = $1", [meetingId])).rows[0].n;
check("los fragmentos llegan durante la grabación", () => assert.ok(midChunks >= 2, `chunks=${midChunks}`));

await meet.locator("#stop").click();
await meet.locator("text=¡Listo!").waitFor({ timeout: 120000 });
await meet.screenshot({ path: path.join(TMP, "06-meeting-sent.png") });
log("grabación enviada; esperando procesamiento");

const row = await waitFor(
  async () => {
    const r = (await db.query("SELECT * FROM meetings WHERE id = $1", [meetingId])).rows[0];
    if (r.status === "failed") throw new Error(`falló: ${r.stage} ${r.error}`);
    return r.status === "done" ? r : null;
  },
  { timeout: 90000, label: "reunión procesada" },
);
const captured = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__captured`)).json();

check("reunión procesada (status=done)", () => assert.equal(row.status, "done"));
check("plataforma detectada = meet", () => assert.equal(row.platform, "meet"));
check("zona horaria del navegador guardada", () => assert.equal(row.timezone, "America/Mexico_City"));
const leftover = (await db.query("SELECT count(*)::int AS n FROM audio_chunks WHERE meeting_id = $1", [meetingId])).rows[0].n;
check("no quedan fragmentos de audio en la base de datos", () => assert.equal(leftover, 0));
check("duración registrada ≈ tiempo grabado", () => assert.ok(Math.abs(row.duration_sec - RECORD_SECONDS) <= 8, `duration=${row.duration_sec}`));

const dg = captured.deepgram[0];
check("Deepgram recibe el audio con la configuración correcta", () => {
  assert.ok(dg, "no hubo llamada");
  assert.equal(dg.auth, "Token test-deepgram");
  assert.equal(dg.contentType, "audio/webm");
  assert.equal(dg.query.model, "nova-3");
  assert.equal(dg.query.diarize, "true");
  assert.equal(dg.query.language, "multi");
});
check("el audio enviado es un WebM válido de la duración esperada", () =>
  assert.ok(dg.duration >= RECORD_SECONDS - 6, `ffprobe=${dg.duration}s`),
);

function meanVolume(file, f) {
  const r = require("node:child_process").spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", file, "-af", `bandpass=f=${f}:width_type=q:w=8,volumedetect`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
  return m ? (m[1] === "-inf" ? -120 : Number(m[1])) : -120;
}
const mic1500 = meanVolume(dg.file, 1500);
const ctl1 = meanVolume(dg.file, 4000);
log(`navegador A (micrófono simulado): 1500Hz=${mic1500}dB (micrófono) 4000Hz=${ctl1}dB (control)`);
check("tu micrófono se mezcla en la grabación", () => assert.ok(mic1500 > ctl1 + 15, `${mic1500} vs ${ctl1}`));

const an = captured.anthropic[0];
check("Claude recibe la transcripción con salida estructurada", () => {
  assert.ok(an, "no hubo llamada");
  assert.equal(an.auth, "Bearer test-anthropic");
  assert.equal(an.model, "claude-opus-5-5");
  assert.equal(an.stream, true);
  assert.equal(an.fallbacks, "default");
  assert.ok(String(an.beta).includes("server-side-fallback-2026-07-01"));
  assert.equal(an.hasSchema, true);
  assert.equal(an.effort, "medium");
  assert.ok(an.prompt.includes("Hablante 2:"), "la transcripción no está en el prompt");
  assert.ok(an.prompt.includes("Plataforma: Google Meet"));
});
check("análisis guardado", () => {
  assert.equal(row.analysis.decisions[0], "Retrasar el lanzamiento al día 14.");
  assert.equal(row.title, "Lanzamiento de la versión 2 y presupuesto");
  assert.ok(row.transcript.length >= 4);
});

const mail = captured.resend[0];
check("correo enviado con informe y transcripción adjunta", () => {
  assert.ok(mail, "no hubo correo");
  assert.equal(mail.auth, "Bearer test-resend");
  assert.deepEqual(mail.to, [EMAIL_TO]);
  assert.match(mail.subject, /Lanzamiento de la versión 2/);
  assert.ok(mail.htmlBytes > 2000);
  assert.equal(mail.attachments.length, 1);
  assert.match(mail.attachments[0].filename, /^transcripcion-\d{4}-\d{2}-\d{2}\.txt$/);
  assert.match(mail.attachments[0].content, /Hablante 2: Gracias, Marta/);
  assert.ok(mail.text.includes(`${APP}/dashboard/meetings/${meetingId}`));
});
check("email_id guardado", () => assert.equal(row.email_id, "email_mock_1"));

// Panel con la reunión
await panel.goto(`${APP}/dashboard`);
await panel.screenshot({ path: path.join(TMP, "07-dashboard-list.png"), fullPage: true });
const listText = await panel.textContent("body");
check("el panel lista la reunión como «Enviado»", () => {
  assert.ok(listText.includes("Lanzamiento de la versión 2 y presupuesto"));
  assert.ok(listText.includes("Enviado"));
});
await panel.goto(`${APP}/dashboard/meetings/${meetingId}`);
await panel.screenshot({ path: path.join(TMP, "08-meeting-detail.png"), fullPage: true });
const detail = await panel.textContent("body");
check("la página de la reunión muestra análisis y transcripción", () => {
  assert.ok(detail.includes("Retrasar el lanzamiento al día 14."));
  assert.ok(detail.includes("Preparar el plan de pruebas de pago"));
  assert.ok(detail.includes("Hablante 2 (Carlos)"));
  assert.ok(detail.includes("Gracias, Marta"));
});
const mobile = await pctx.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(`${APP}/dashboard/meetings/${meetingId}`);
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
await mobile.screenshot({ path: path.join(TMP, "09-mobile-detail.png"), fullPage: true });
check("vista móvil sin desplazamiento horizontal", () => assert.equal(overflow, false));
await mobile.close();

// Reenviar correo
await panel.click("text=Reenviar correo");
await waitFor(
  async () => (await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__captured`)).json()).resend.length >= 2,
  { timeout: 30000, label: "reenvío" },
);
const afterResend = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__captured`)).json();
check("«Reenviar correo» envía otro correo sin repetir transcripción ni IA", () => {
  assert.equal(afterResend.resend.length, 2);
  assert.equal(afterResend.deepgram.length, 1);
  assert.equal(afterResend.anthropic.length, 1);
});

// Ajustes
await panel.goto(`${APP}/dashboard`);
await panel.fill("#emailTo", "otro@example.com, copia@example.com");
await panel.selectOption("#tl", "es");
await panel.click("form.settings button[type=submit]");
await panel.waitForURL(/settings=saved/);
const st = Object.fromEntries((await db.query("SELECT key, value FROM settings")).rows.map((r) => [r.key, r.value]));
check("ajustes guardados", () => {
  assert.equal(st.email_to, "otro@example.com, copia@example.com");
  assert.equal(st.transcription_language, "es");
});

// ------------------------------------------------------------------ 4. Cerrar la pestaña a mitad de la grabación
log("escenario: navegador sin micrófono, cerrar la pestaña grabando");
await ctx.close();
const ctxB = await launchWithExtension("b", { fakeMic: false });
const meet2 = await ctxB.newPage();
await meet2.goto("https://meet.google.com/xyz-abcd-efg");
await meet2.locator("#start").waitFor({ timeout: 15000 });
await meet2.evaluate(() => document.getElementById("a").play());
await meet2.locator("#start").click();
await meet2.locator("#stop").waitFor({ timeout: 20000 });
const warnText = await meet2.locator("#minuta-root").evaluate((h) => h.shadowRoot.textContent);
check("sin micrófono, la grabación continúa con un aviso", () => assert.match(warnText, /No se pudo usar tu micrófono/));
await meet2.screenshot({ path: path.join(TMP, "10-recording-no-mic.png") });
await sleep(20000);
await meet2.close();
const row2 = await waitFor(
  async () => {
    const r = (await db.query("SELECT * FROM meetings ORDER BY created_at DESC LIMIT 1")).rows[0];
    if (r.id === meetingId) return null;
    if (r.status === "failed") throw new Error(`falló: ${r.stage} ${r.error}`);
    return r.status === "done" ? r : null;
  },
  { timeout: 60000, label: "reunión abandonada procesada" },
);
const cap2 = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__captured`)).json();
check("al cerrar la pestaña, la reunión se procesa y se envía igualmente", () => {
  assert.equal(row2.status, "done");
  assert.equal(cap2.resend.length, 3);
  assert.deepEqual(cap2.resend[2].to, ["otro@example.com", "copia@example.com"]);
  assert.equal(cap2.deepgram[1].query.language, "es");
});
const tabFile = cap2.deepgram[1].file;
const tab440 = meanVolume(tabFile, 440);
const tab880 = meanVolume(tabFile, 880);
const ctl2 = meanVolume(tabFile, 4000);
log(`navegador B (sin simulación): 440Hz=${tab440}dB (pestaña) 880Hz=${tab880}dB 4000Hz=${ctl2}dB (control)`);
check("el audio de la pestaña (los demás participantes) se graba fielmente a 440 Hz", () => {
  assert.ok(tab440 > ctl2 + 15, `${tab440} vs control ${ctl2}`);
  assert.ok(tab440 > tab880 + 10, `440=${tab440} debe dominar sobre 880=${tab880}`);
});
check("duración de la grabación abandonada ≈ 20 s", () => assert.ok(cap2.deepgram[1].duration >= 14, `dur=${cap2.deepgram[1].duration}`));

await ctxB.close();
await plain.close();
await db.end();

// ------------------------------------------------------------------ resumen
const failed = results.filter((r) => !r.ok);
console.log(`\n[e2e] ${results.length - failed.length}/${results.length} comprobaciones superadas`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.err}`);
  process.exit(1);
}
process.exit(0);
