import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader, StatusBadge } from "@/components/AppHeader";
import { isDashboardAuthed } from "@/lib/auth";
import { q } from "@/lib/db";
import { configStatus } from "@/lib/env";
import { clock, formatDate, PLATFORM_NAMES } from "@/lib/format";
import { parseRecipients } from "@/lib/mailer";
import { getSettings } from "@/lib/settings";
import { humanWait, providerStatus, type ProviderRow } from "@/lib/status";

export const dynamic = "force-dynamic";

interface Row {
  id: string;
  platform: string;
  title: string;
  status: string;
  started_at: Date;
  duration_sec: number | null;
  timezone: string | null;
}

const CHECK_LABELS: Record<string, string> = {
  database: "Base de datos",
  apiKey: "Clave de la extensión",
  transcription: "Transcripción de voz",
  analysis: "Análisis con IA",
  email: "Correo",
};

function ProviderList({ title, rows }: { title: string; rows: ProviderRow[] }) {
  const now = Date.now();
  return (
    <div style={{ marginBottom: 14 }}>
      <strong style={{ fontSize: 14 }}>{title}</strong>
      <ul className="check">
        {rows.map((r) => {
          const paused = r.configured && r.blockedUntil && r.blockedUntil.getTime() > now;
          return (
            <li key={r.id} title={paused ? r.reason : undefined}>
              <span className={!r.configured ? "n" : paused ? "p" : "y"}>{!r.configured ? "✗" : paused ? "⏸" : "✓"}</span>
              <span>
                {r.label}
                {!r.configured && <span className="hint"> · falta {r.keyName}</span>}
                {paused && r.blockedUntil && <span className="hint"> · en pausa, vuelve en {humanWait(r.blockedUntil, now)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ settings?: string; deleted?: string; why?: string }>;
}) {
  if (!(await isDashboardAuthed())) redirect("/login");
  const sp = await searchParams;
  const [meetings, settings, providers] = await Promise.all([
    q<Row>(
      "SELECT id, platform, title, status, started_at, duration_sec, timezone FROM meetings ORDER BY started_at DESC LIMIT 100",
    ),
    getSettings(),
    providerStatus(),
  ]);
  const config = configStatus();
  const missing = Object.entries(config).filter(([, v]) => !v);
  const busy = meetings.some((m) => m.status === "processing");

  return (
    <>
      {busy && <meta httpEquiv="refresh" content="8" />}
      <AppHeader />
      <main className="wrap page">
        <div className="page-head">
          <div>
            <h1>Tus reuniones</h1>
            <p className="sub">{meetings.length} grabaciones</p>
          </div>
          <a href="/api/extension" className="btn">
            Descargar extensión
          </a>
        </div>

        {sp.settings === "saved" && <div className="banner ok">Ajustes guardados.</div>}
        {sp.settings === "invalid-email" && <div className="banner err">{sp.why ?? "El correo no es válido."}</div>}
        {sp.deleted && <div className="banner ok">Reunión eliminada.</div>}
        {missing.length > 0 && (
          <div className="banner warn">
            Falta configurar: {missing.map(([k]) => CHECK_LABELS[k] ?? k).join(", ")}. Hasta entonces las reuniones no
            se podrán procesar.
          </div>
        )}
        {!settings.emailTo && (
          <div className="banner warn">Añade el correo donde quieres recibir los informes en «Ajustes».</div>
        )}

        <div className="cols">
          <section className="card" aria-labelledby="h-list">
            <h2 id="h-list">Historial</h2>
            {meetings.length === 0 ? (
              <p className="empty">
                Todavía no hay reuniones. Instala la extensión y pulsa «Grabar esta reunión» en tu próxima llamada.
              </p>
            ) : (
              <ul className="list">
                {meetings.map((m) => (
                  <li key={m.id}>
                    <Link href={`/dashboard/meetings/${m.id}`} className="row-link">
                      <div className="row-main">
                        <div className="row-title">{m.title || "Reunión sin título"}</div>
                        <div className="row-meta">
                          {PLATFORM_NAMES[m.platform] ?? m.platform} · {formatDate(m.started_at, m.timezone)}
                          {m.duration_sec ? ` · ${clock(m.duration_sec)}` : ""}
                        </div>
                      </div>
                      <StatusBadge status={m.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="stack">
            <section className="card" aria-labelledby="h-install">
              <h2 id="h-install">Instalar en Chrome</h2>
              <ol className="steps">
                <li>
                  Pulsa <strong>Descargar extensión</strong> y descomprime el archivo.
                </li>
                <li>
                  Abre <code>chrome://extensions</code> y activa el <strong>Modo desarrollador</strong>.
                </li>
                <li>
                  Pulsa <strong>Cargar descomprimida</strong> y elige la carpeta <code>minuta-extension</code>.
                </li>
                <li>Entra en una reunión y pulsa «Grabar esta reunión».</li>
              </ol>
              <p className="hint">La extensión ya lleva tu clave dentro: no la compartas.</p>
            </section>

            <section className="card" aria-labelledby="h-settings">
              <h2 id="h-settings">Ajustes</h2>
              <form method="post" action="/api/settings" className="settings">
                <label htmlFor="emailTo">Enviar informes a</label>
                <textarea
                  id="emailTo"
                  name="emailTo"
                  rows={3}
                  defaultValue={parseRecipients(settings.emailTo).join("\n")}
                  placeholder={"tu@correo.com\notra@persona.com"}
                />
                <p className="hint">
                  Uno por línea (o separados por comas), hasta 10. Con Resend sin dominio solo llega al correo de tu cuenta;
                  para el resto configura SMTP (Gmail).
                </p>
                <label htmlFor="tl">Idioma de las reuniones</label>
                <select id="tl" name="transcriptionLanguage" defaultValue={settings.transcriptionLanguage}>
                  <option value="multi">Detectar (español e inglés mezclados)</option>
                  <option value="es">Español</option>
                  <option value="en">Inglés</option>
                </select>
                <label htmlFor="rl">Idioma del informe</label>
                <select id="rl" name="reportLanguage" defaultValue={settings.reportLanguage}>
                  <option value="es">Español</option>
                  <option value="en">Inglés</option>
                </select>
                <label className="inline">
                  <input type="checkbox" name="keepAudio" defaultChecked={settings.keepAudio} /> Conservar el audio
                  después de procesar
                </label>
                <button type="submit" className="btn" style={{ marginTop: 14 }}>
                  Guardar
                </button>
              </form>
            </section>

            <section className="card" aria-labelledby="h-prov">
              <h2 id="h-prov">IA y correo (rotación automática)</h2>
              <p className="hint" style={{ marginBottom: 10 }}>
                Se usa el primero disponible; si uno alcanza su límite, pasa solo al siguiente y vuelve a probarlo cuando
                termina su pausa.
              </p>
              <ProviderList title="Transcripción de voz" rows={providers.stt} />
              <ProviderList title="Análisis de la reunión" rows={providers.analysis} />
              <ProviderList title="Envío del correo" rows={providers.email} />
            </section>

            <section className="card" aria-labelledby="h-status">
              <h2 id="h-status">Estado del sistema</h2>
              <ul className="check">
                {Object.entries(config).map(([k, v]) => (
                  <li key={k}>
                    <span className={v ? "y" : "n"}>{v ? "✓" : "✗"}</span> {CHECK_LABELS[k] ?? k}
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}
