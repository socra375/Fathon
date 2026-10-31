// Minuta · script de contenido
// Inserta el botón flotante en Google Meet, Microsoft Teams y Zoom (web),
// graba el audio de la pestaña + tu micrófono y lo envía al servidor en fragmentos.
(() => {
  if (window.__minutaLoaded) return;
  window.__minutaLoaded = true;

  const CHUNK_MS = 15000;
  const BITRATE = 48000;
  const NOTICE =
    "Aviso: estoy grabando esta reunión con Minuta para generar notas y un resumen. Si alguien no está de acuerdo, dímelo y detengo la grabación.";

  // ---------------------------------------------------------------- plataforma
  function detectPlatform() {
    const h = location.hostname;
    if (h === "meet.google.com") return "meet";
    if (h.startsWith("teams.") || h === "teams.cloud.microsoft") return "teams";
    if (h === "zoom.us" || h.endsWith(".zoom.us")) return "zoom";
    return "other";
  }
  const PLATFORM = detectPlatform();

  function isMeetingPage() {
    const p = location.pathname;
    if (PLATFORM === "meet") return /^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(\/|$)/i.test(p);
    if (PLATFORM === "zoom") return /\/wc\//.test(p);
    if (PLATFORM === "teams") return true;
    return false;
  }

  // ---------------------------------------------------------------- mensajería
  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r || { ok: false, error: "Sin respuesta de la extensión" };
    } catch (err) {
      const m = String((err && err.message) || err);
      if (/context invalidated/i.test(m)) return { ok: false, error: "La extensión se actualizó. Recarga la página." };
      return { ok: false, error: m };
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- estado de grabación
  const rec = {
    state: "idle", // idle | starting | recording | finishing | sent | error
    id: null,
    startedAt: 0,
    recorder: null,
    display: null,
    mic: null,
    ctx: null,
    seq: 0,
    queue: [],
    pumping: false,
    unstable: false,
    message: "",
    timer: null,
  };

  async function uploadOne(item) {
    const data = await blobToBase64(item.blob);
    const delays = [1000, 2000, 4000, 8000, 15000];
    for (let attempt = 0; ; attempt++) {
      const r = await send({ type: "session:chunk", id: item.id, seq: item.seq, data });
      if (r.ok || r.status === 409 || r.status === 404 || r.status === 401) {
        rec.unstable = false;
        return;
      }
      rec.unstable = true;
      render();
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
      if (attempt > 40) return; // ~10 min sin conexión: se descarta este fragmento
    }
  }

  async function pump() {
    if (rec.pumping) return;
    rec.pumping = true;
    try {
      while (rec.queue.length) {
        await uploadOne(rec.queue[0]);
        rec.queue.shift();
      }
    } finally {
      rec.pumping = false;
      render();
    }
  }

  async function drain(timeoutMs = 120000) {
    const until = Date.now() + timeoutMs;
    pump();
    while ((rec.queue.length || rec.pumping) && Date.now() < until) await sleep(250);
  }

  function stopTracks() {
    for (const s of [rec.display, rec.mic]) if (s) s.getTracks().forEach((t) => t.stop());
    if (rec.ctx) rec.ctx.close().catch(() => {});
    rec.display = rec.mic = rec.ctx = null;
  }

  async function includeMic() {
    try {
      const { includeMic } = await chrome.storage.local.get("includeMic");
      return includeMic !== false;
    } catch {
      return true;
    }
  }

  async function start() {
    if (rec.state === "recording" || rec.state === "starting" || rec.state === "finishing") return;
    setState("starting", "Elige «Esta pestaña» y deja marcado «Compartir también el audio de la pestaña».");
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: { ideal: 320 }, height: { ideal: 180 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
        },
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
        systemAudio: "exclude",
        monitorTypeSurfaces: "exclude",
      });
    } catch (err) {
      const name = err && err.name;
      setState(
        "error",
        name === "NotAllowedError"
          ? "Grabación cancelada."
          : name === "NotReadableError"
            ? "Chrome no pudo acceder al audio de la pestaña. Comprueba que tienes un dispositivo de sonido activo y vuelve a intentarlo."
            : `No se pudo capturar la pestaña: ${err && err.message}`,
      );
      return;
    }
    const tabTrack = display.getAudioTracks()[0];
    if (!tabTrack) {
      display.getTracks().forEach((t) => t.stop());
      setState("error", "No se compartió el audio. Vuelve a intentarlo y marca «Compartir también el audio de la pestaña».");
      return;
    }
    rec.display = display;

    let micWarning = "";
    if (await includeMic()) {
      try {
        rec.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        micWarning = "No se pudo usar tu micrófono: solo se grabará a los demás.";
      }
    }

    const ctx = new AudioContext();
    rec.ctx = ctx;
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream([tabTrack])).connect(dest);
    if (rec.mic) ctx.createMediaStreamSource(rec.mic).connect(dest);
    // La pestaña sigue sonando con normalidad (suppressLocalAudioPlayback: false).
    await ctx.resume().catch(() => {});

    let timezone = "";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {}
    const s = await send({ type: "session:start", platform: PLATFORM, title: document.title, url: location.href, timezone });
    if (!s.ok) {
      stopTracks();
      setState("error", s.error || "No se pudo iniciar la grabación.");
      return;
    }

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: BITRATE });
    rec.id = s.id;
    rec.seq = 0;
    rec.queue = [];
    rec.recorder = recorder;
    rec.startedAt = Date.now();
    const sessionId = s.id;
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        rec.queue.push({ id: sessionId, seq: rec.seq++, blob: ev.data });
        pump();
      }
    };
    // Si el usuario pulsa «Dejar de compartir» en la barra de Chrome, se termina igual.
    tabTrack.addEventListener("ended", () => finish());
    const v = display.getVideoTracks()[0];
    if (v) v.addEventListener("ended", () => finish());

    recorder.start(CHUNK_MS);
    setState("recording", micWarning);
    rec.timer = setInterval(render, 1000);
  }

  async function finish() {
    if (rec.state !== "recording") return;
    setState("finishing", "Subiendo el audio…");
    clearInterval(rec.timer);
    const durationSec = Math.round((Date.now() - rec.startedAt) / 1000);
    const recorder = rec.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }
    stopTracks();
    await drain();
    const r = await send({ type: "session:finish", id: rec.id, durationSec });
    rec.recorder = null;
    if (!r.ok) {
      setState("error", `El audio se subió, pero no se pudo cerrar la grabación: ${r.error}. Puedes procesarla desde el panel.`);
      return;
    }
    setState("sent", "¡Listo! Recibirás el resumen por correo en unos minutos.");
    setTimeout(() => {
      if (rec.state === "sent") setState("idle");
    }, 15000);
  }

  // Cierre de pestaña o navegación fuera de la reunión.
  window.addEventListener("pagehide", () => {
    if (rec.state !== "recording" || !rec.id) return;
    try {
      rec.recorder && rec.recorder.state !== "inactive" && rec.recorder.requestData();
    } catch {}
    send({ type: "session:abandon", id: rec.id, durationSec: Math.round((Date.now() - rec.startedAt) / 1000) });
  });

  // ---------------------------------------------------------------- interfaz
  const host = document.createElement("div");
  host.id = "minuta-root";
  host.style.cssText = "all:initial;position:fixed;top:88px;right:16px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .card { width: 264px; background: #ffffff; color: #16181d; border: 1px solid #e3e6eb; border-radius: 14px;
            box-shadow: 0 8px 28px rgba(16,24,40,.18); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: grab; user-select: none; }
    .head:active { cursor: grabbing; }
    .brand { font-weight: 700; font-size: 14px; color: #3b5bdb; flex: 1; letter-spacing: -.01em; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #3b5bdb; flex: none; }
    .rec .dot { background: #e03131; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    .time { font-variant-numeric: tabular-nums; font-size: 13px; color: #5d6472; }
    .icon { border: 0; background: transparent; color: #5d6472; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
    .icon:hover { background: #f1f3f5; }
    .body { padding: 0 12px 12px; }
    .msg { font-size: 12.5px; line-height: 1.45; color: #5d6472; margin: 0 0 10px; }
    .msg.err { color: #c92a2a; }
    .msg.ok { color: #2b8a3e; }
    .btn { width: 100%; border: 0; border-radius: 10px; padding: 10px 12px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .btn:focus-visible, .icon:focus-visible, .link:focus-visible { outline: 2px solid #3b5bdb; outline-offset: 2px; }
    .primary { background: #3b5bdb; color: #fff; }
    .primary:hover { background: #364fc7; }
    .danger { background: #e03131; color: #fff; }
    .danger:hover { background: #c92a2a; }
    .btn[disabled] { opacity: .6; cursor: progress; }
    .link { display: inline-block; margin-top: 8px; font-size: 12px; color: #3b5bdb; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
    .mini { width: 44px; height: 44px; border-radius: 50%; border: 1px solid #e3e6eb; background: #fff; box-shadow: 0 6px 20px rgba(16,24,40,.18);
            display: grid; place-items: center; cursor: pointer; }
    .mini .dot { width: 14px; height: 14px; }
    .warn { font-size: 12px; color: #e8590c; margin: -4px 0 8px; }
    @media (prefers-color-scheme: dark) {
      .card, .mini { background: #1d2026; color: #eceef2; border-color: #343a44; }
      .msg, .time, .icon { color: #a7adb8; }
      .icon:hover { background: #2a2f37; }
    }
  </style>
  <div id="ui"></div>`;
  const ui = root.getElementById("ui");
  let collapsed = false;

  function setState(state, message = "") {
    rec.state = state;
    rec.message = message;
    if (state === "recording" || state === "starting" || state === "finishing" || state === "error") collapsed = false;
    render();
  }

  function elapsed() {
    if (!rec.startedAt) return "00:00";
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function render() {
    const st = rec.state;
    if (collapsed && st !== "recording") {
      ui.innerHTML = `<button class="mini" id="expand" title="Minuta" aria-label="Abrir Minuta"><span class="dot"></span></button>`;
      root.getElementById("expand").onclick = () => {
        collapsed = false;
        render();
      };
      return;
    }
    const recording = st === "recording";
    const msgClass = st === "error" ? "msg err" : st === "sent" ? "msg ok" : "msg";
    let action = "";
    if (st === "idle" || st === "error" || st === "sent") {
      action = `<button class="btn primary" id="start">${st === "error" ? "Reintentar grabación" : "Grabar esta reunión"}</button>`;
    } else if (st === "starting") {
      action = `<button class="btn primary" disabled>Esperando permiso…</button>`;
    } else if (recording) {
      action = `<button class="btn danger" id="stop">Terminar y enviar</button>
                <button class="link" id="notice">Copiar aviso de grabación para el chat</button>`;
    } else if (st === "finishing") {
      action = `<button class="btn primary" disabled>Enviando…</button>`;
    }
    const defaultMsg =
      st === "idle" ? "Al terminar la reunión recibirás por correo la transcripción, el resumen y las tareas." : "";
    const text = rec.message || defaultMsg;
    ui.innerHTML = `
      <div class="card ${recording ? "rec" : ""}" role="region" aria-label="Minuta">
        <div class="head" id="drag">
          <span class="dot"></span>
          <span class="brand">Minuta</span>
          ${recording || st === "finishing" ? `<span class="time" aria-live="off">${elapsed()}</span>` : ""}
          ${recording ? "" : `<button class="icon" id="collapse" title="Minimizar" aria-label="Minimizar">–</button>`}
        </div>
        <div class="body">
          ${rec.unstable ? `<p class="warn">Conexión inestable: reintentando la subida…</p>` : ""}
          ${text ? `<p class="${msgClass}" role="status">${escapeHtml(text)}</p>` : ""}
          ${action}
        </div>
      </div>`;
    const b = (id) => root.getElementById(id);
    if (b("start")) b("start").onclick = start;
    if (b("stop")) b("stop").onclick = finish;
    if (b("collapse")) b("collapse").onclick = () => {
      collapsed = true;
      render();
    };
    if (b("notice"))
      b("notice").onclick = async () => {
        try {
          await navigator.clipboard.writeText(NOTICE);
          b("notice").textContent = "Aviso copiado. Pégalo en el chat de la reunión.";
        } catch {
          b("notice").textContent = NOTICE;
        }
      };
    enableDrag(b("drag"));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function enableDrag(handle) {
    if (!handle) return;
    handle.onpointerdown = (ev) => {
      if (ev.target.closest("button")) return;
      const startY = ev.clientY;
      const startTop = host.getBoundingClientRect().top;
      handle.setPointerCapture(ev.pointerId);
      handle.onpointermove = (e) => {
        const top = Math.min(window.innerHeight - 60, Math.max(8, startTop + e.clientY - startY));
        host.style.top = `${top}px`;
      };
      handle.onpointerup = () => {
        handle.onpointermove = null;
        handle.onpointerup = null;
      };
    };
  }

  // Mostrar u ocultar según la página (Meet y Zoom son aplicaciones de una sola página).
  function sync() {
    const shouldShow = isMeetingPage() || rec.state !== "idle";
    if (shouldShow && !host.isConnected) {
      document.documentElement.appendChild(host);
      render();
    } else if (!shouldShow && host.isConnected) {
      host.remove();
    }
  }
  sync();
  setInterval(sync, 1500);
})();
