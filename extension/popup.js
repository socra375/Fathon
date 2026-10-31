const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const MISSING = {
  database: "Base de datos",
  apiKey: "Clave de la extensión",
  transcription: "Transcripción (Groq o Deepgram)",
  anthropic: "Anthropic (IA)",
  resend: "Resend (correo)",
};

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "status" });
  const box = $("status");
  if (!st || !st.configured) {
    box.innerHTML = `<p class="err">La extensión no está conectada.</p><p class="muted small">Descárgala desde tu panel de Minuta o rellena «Conexión avanzada».</p>`;
    $("dashboard").hidden = true;
    return;
  }
  $("dashboard").href = `${st.serverUrl}/dashboard`;
  if (st.healthError || !st.health) {
    box.innerHTML = `<p class="err">No se puede conectar con el servidor.</p><p class="muted small">${esc(st.healthError || "")}</p>`;
    return;
  }
  const recording = Object.keys(st.active || {}).length;
  if (st.health.ready) {
    box.innerHTML = `<p class="ok">● Conectado y listo</p>${recording ? `<p class="small">Grabando en ${recording} pestaña(s).</p>` : ""}`;
  } else {
    const missing = Object.entries(st.health.config || {})
      .filter(([, v]) => !v)
      .map(([k]) => `<li>${esc(MISSING[k] || k)}</li>`)
      .join("");
    box.innerHTML = `<p class="err">Conectado, pero falta configurar:</p><ul class="small">${missing || "<li>Base de datos</li>"}</ul>`;
  }
}

async function init() {
  const s = await chrome.storage.local.get(["includeMic", "serverUrl", "apiKey"]);
  $("includeMic").checked = s.includeMic !== false;
  $("includeMic").addEventListener("change", (e) => chrome.storage.local.set({ includeMic: e.target.checked }));
  $("serverUrl").value = s.serverUrl || "";
  $("apiKey").value = s.apiKey || "";
  $("adv").addEventListener("submit", async (e) => {
    e.preventDefault();
    await chrome.storage.local.set({ serverUrl: $("serverUrl").value.trim(), apiKey: $("apiKey").value.trim() });
    $("saved").hidden = false;
    refresh();
  });
  refresh();
}

init();
