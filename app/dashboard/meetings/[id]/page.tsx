import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppHeader, STAGE_LABELS, StatusBadge } from "@/components/AppHeader";
import { isDashboardAuthed } from "@/lib/auth";
import { q } from "@/lib/db";
import { clock, formatDate, PLATFORM_NAMES, speakerLabel, talkShares } from "@/lib/format";
import { isUuid } from "@/lib/http";
import type { MeetingRow } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

const SENTIMENT: Record<string, string> = {
  positive: "Positivo",
  neutral: "Neutral",
  negative: "Negativo",
  mixed: "Mixto",
};

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="sub">{empty}</p>;
  return (
    <ul className="bullets">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ queued?: string }>;
}) {
  if (!(await isDashboardAuthed())) redirect("/login");
  const { id } = await params;
  const { queued } = await searchParams;
  if (!isUuid(id)) notFound();
  const [m] = await q<MeetingRow>("SELECT * FROM meetings WHERE id = $1", [id]);
  if (!m) notFound();

  const a = m.analysis;
  const utts = m.transcript ?? [];
  const talk = talkShares(utts);
  const names = new Map((a?.speakers ?? []).map((s) => [s.label.toLowerCase(), s]));
  const nameOf = (speaker: number) => {
    const label = speakerLabel(speaker);
    const n = names.get(label.toLowerCase())?.likely_name;
    return n ? `${label} (${n})` : label;
  };
  const busy = m.status === "processing" || Boolean(queued && m.status !== "done" && m.status !== "failed");
  const abandoned = m.status === "recording" && Date.now() - new Date(m.updated_at).getTime() > 5 * 60_000;

  return (
    <>
      {busy && <meta httpEquiv="refresh" content="6" />}
      <AppHeader />
      <main className="wrap page">
        <p style={{ marginBottom: 12 }}>
          <Link href="/dashboard">← Volver</Link>
        </p>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <h1>{a?.title || m.title || "Reunión sin título"}</h1>
            <p className="sub">
              {PLATFORM_NAMES[m.platform] ?? m.platform} · {formatDate(m.started_at, m.timezone)}
              {m.duration_sec ? ` · ${clock(m.duration_sec)}` : ""}
              {m.emailed_at ? ` · Enviado a ${m.email_to}` : ""}
            </p>
          </div>
          <StatusBadge status={m.status} />
        </div>

        {m.status === "processing" && (
          <div className="banner warn" role="status">
            Procesando{m.stage ? `: ${STAGE_LABELS[m.stage] ?? m.stage}` : ""}… Esta página se actualiza sola.
          </div>
        )}
        {m.status === "failed" && (
          <div className="banner err" role="alert">
            Falló en {STAGE_LABELS[m.stage ?? ""] ?? "el procesamiento"}: {m.error}
          </div>
        )}
        {m.status === "recording" && (
          <div className="banner warn">
            {abandoned
              ? "Esta grabación no se cerró (¿se cerró la pestaña o se perdió la conexión?). Puedes procesar lo que se subió."
              : "Grabación en curso."}{" "}
            Fragmentos recibidos: {m.chunk_count}.
          </div>
        )}

        <div className="actions" style={{ marginBottom: 16 }}>
          {(m.status === "failed" || abandoned) && (
            <form method="post" action={`/api/meetings/${m.id}/retry`}>
              <button className="btn" type="submit">
                {m.status === "failed" ? "Reintentar" : "Procesar ahora"}
              </button>
            </form>
          )}
          {a && (m.status === "done" || m.status === "failed") && (
            <form method="post" action={`/api/meetings/${m.id}/resend`}>
              <button className="btn secondary" type="submit">
                Reenviar correo
              </button>
            </form>
          )}
          <form method="post" action={`/api/meetings/${m.id}/delete`}>
            <button className="btn danger" type="submit">
              Eliminar
            </button>
          </form>
        </div>

        {a && (
          <div className="cols">
            <div className="stack">
              <section className="card">
                <h2>Resumen</h2>
                <p className="summary">{a.summary}</p>
              </section>
              <section className="card">
                <h2>Decisiones</h2>
                <Bullets items={a.decisions} empty="No se tomaron decisiones explícitas." />
              </section>
              <section className="card">
                <h2>Tareas</h2>
                {a.action_items.length === 0 ? (
                  <p className="sub">No se detectaron tareas.</p>
                ) : (
                  <table className="tasks">
                    <thead>
                      <tr>
                        <th>Responsable</th>
                        <th>Tarea</th>
                        <th>Plazo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.action_items.map((t, i) => (
                        <tr key={i}>
                          <td>{t.owner}</td>
                          <td>{t.task}</td>
                          <td>{t.due || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section className="card">
                <h2>Temas</h2>
                {a.topics.length === 0 ? (
                  <p className="sub">Sin temas.</p>
                ) : (
                  a.topics.map((t, i) => (
                    <div className="topic" key={i}>
                      <span className="t">{t.start}</span>
                      <div>
                        <strong>{t.title}</strong>
                        <div className="sub">{t.summary}</div>
                      </div>
                    </div>
                  ))
                )}
              </section>
              {a.follow_up_email.body && (
                <section className="card">
                  <h2>Correo de seguimiento sugerido</h2>
                  <p className="sub" style={{ marginBottom: 8 }}>
                    Asunto: <strong>{a.follow_up_email.subject}</strong>
                  </p>
                  <div className="mailbox">{a.follow_up_email.body}</div>
                </section>
              )}
            </div>
            <aside className="stack">
              <section className="card">
                <h2>Puntos clave</h2>
                <Bullets items={a.key_points} empty="—" />
              </section>
              <section className="card">
                <h2>Participación</h2>
                {talk.length === 0 && <p className="sub">—</p>}
                {talk.map((t) => {
                  const info = names.get(speakerLabel(t.speaker).toLowerCase());
                  return (
                    <div key={t.speaker} style={{ fontSize: 14, marginBottom: 10 }}>
                      <div>
                        <strong className={`s${t.speaker % 6}`}>{nameOf(t.speaker)}</strong>{" "}
                        <span className="sub" style={{ display: "inline" }}>
                          · {t.pct}% · {clock(t.seconds)}
                        </span>
                      </div>
                      <div className="bar">
                        <span style={{ width: `${Math.max(2, t.pct)}%` }} />
                      </div>
                      {info?.contribution && <div className="sub">{info.contribution}</div>}
                    </div>
                  );
                })}
              </section>
              <section className="card">
                <h2>Tono</h2>
                <p>
                  <strong>{SENTIMENT[a.sentiment.overall] ?? a.sentiment.overall}.</strong> {a.sentiment.explanation}
                </p>
              </section>
              <section className="card">
                <h2>Preguntas abiertas</h2>
                <Bullets items={a.open_questions} empty="Ninguna." />
              </section>
              <section className="card">
                <h2>Riesgos y objeciones</h2>
                <Bullets items={a.risks} empty="Ninguno detectado." />
              </section>
            </aside>
          </div>
        )}

        {utts.length > 0 && (
          <section className="card" style={{ marginTop: 16 }}>
            <h2>Transcripción</h2>
            <div className="transcript">
              {utts.map((u, i) => (
                <div className="utt" key={i}>
                  <span className="t">{clock(u.start)}</span>
                  <p>
                    <span className={`s s${u.speaker % 6}`}>{nameOf(u.speaker)}:</span>
                    {u.text}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
