// Minuta · service worker (Manifest V3)
// Hace de puente entre la página de la reunión y el servidor: abre la sesión,
// sube los fragmentos de audio y cierra la grabación.
import { CONFIG } from "./config.js";

async function getConfig() {
  const s = await chrome.storage.local.get(["serverUrl", "apiKey"]);
  const serverUrl = String(s.serverUrl || CONFIG.serverUrl || "").replace(/\/+$/, "");
  const apiKey = String(s.apiKey || CONFIG.apiKey || "");
  return { serverUrl, apiKey };
}

async function api(path, init = {}) {
  const { serverUrl, apiKey } = await getConfig();
  if (!serverUrl || !apiKey) {
    return { ok: false, status: 0, error: "La extensión no está configurada. Descárgala de nuevo desde tu panel de Minuta." };
  }
  let res;
  try {
    res = await fetch(serverUrl + path, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
    });
  } catch (err) {
    return { ok: false, status: 0, error: `Sin conexión con el servidor (${err && err.message ? err.message : err})` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    body,
    error: res.ok ? undefined : (body && body.error) || `Error ${res.status}`,
  };
}

// --- Estado de grabaciones activas (sobrevive a reinicios del service worker) ---
async function getActive() {
  const { active } = await chrome.storage.session.get("active");
  return active || {};
}
async function setActive(tabId, value) {
  const active = await getActive();
  if (value) active[tabId] = value;
  else delete active[tabId];
  await chrome.storage.session.set({ active });
}

function setBadge(tabId, recording) {
  chrome.action.setBadgeText({ tabId, text: recording ? "REC" : "" }).catch(() => {});
  if (recording) chrome.action.setBadgeBackgroundColor({ tabId, color: "#e03131" }).catch(() => {});
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function finishSession(id, durationSec) {
  const r = await api(`/api/sessions/${id}/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ durationSec }),
  });
  return r;
}

const abandonTimers = new Map();

async function handle(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : undefined;
  switch (msg && msg.type) {
    case "session:start": {
      const r = await api("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: msg.platform, title: msg.title, url: msg.url, timezone: msg.timezone }),
      });
      if (!r.ok) return { ok: false, error: r.error };
      if (tabId !== undefined) {
        await setActive(tabId, { id: r.body.id, startedAt: Date.now() });
        setBadge(tabId, true);
      }
      return { ok: true, id: r.body.id };
    }
    case "session:chunk": {
      const r = await api(`/api/sessions/${msg.id}/chunks?seq=${msg.seq}`, {
        method: "POST",
        headers: { "Content-Type": "audio/webm" },
        body: b64ToBytes(msg.data),
      });
      return { ok: r.ok, status: r.status, error: r.error };
    }
    case "session:finish": {
      if (abandonTimers.has(msg.id)) {
        clearTimeout(abandonTimers.get(msg.id));
        abandonTimers.delete(msg.id);
      }
      const r = await finishSession(msg.id, msg.durationSec);
      if (tabId !== undefined) {
        await setActive(tabId, null);
        setBadge(tabId, false);
      }
      return { ok: r.ok, error: r.error };
    }
    case "session:abandon": {
      // La pestaña se está cerrando o navegando: espera a que lleguen los últimos fragmentos.
      const t = setTimeout(() => {
        abandonTimers.delete(msg.id);
        finishSession(msg.id, msg.durationSec);
      }, 8000);
      abandonTimers.set(msg.id, t);
      if (tabId !== undefined) {
        await setActive(tabId, null);
        setBadge(tabId, false);
      }
      return { ok: true };
    }
    case "status": {
      const { serverUrl, apiKey } = await getConfig();
      const health = serverUrl ? await api("/api/health") : null;
      return {
        ok: true,
        serverUrl,
        configured: Boolean(serverUrl && apiKey),
        health: health && health.ok ? health.body : null,
        healthError: health && !health.ok ? health.error : null,
        active: await getActive(),
      };
    }
    default:
      return { ok: false, error: "mensaje desconocido" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true; // respuesta asíncrona
});

// Si se cierra la pestaña a mitad de grabación, se procesa lo que se haya subido.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActive();
  const s = active[tabId];
  if (!s) return;
  await setActive(tabId, null);
  setTimeout(() => finishSession(s.id, Math.round((Date.now() - s.startedAt) / 1000)), 5000);
});
