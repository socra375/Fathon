import Link from "next/link";

export function AppHeader() {
  return (
    <header className="wrap nav">
      <Link href="/dashboard" className="logo">
        <img src="/logo.svg" alt="" />
        Minuta
      </Link>
      <form method="post" action="/api/auth/logout">
        <button type="submit" className="btn ghost">
          Salir
        </button>
      </form>
    </header>
  );
}

const LABELS: Record<string, string> = {
  done: "Enviado",
  processing: "Procesando",
  recording: "Grabando",
  failed: "Error",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{LABELS[status] ?? status}</span>;
}

export const STAGE_LABELS: Record<string, string> = {
  transcribing: "transcripción",
  analyzing: "análisis con IA",
  emailing: "envío del correo",
};
