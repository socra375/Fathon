import Link from "next/link";
import { redirect } from "next/navigation";
import { isDashboardAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isDashboardAuthed()) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="login">
      <div className="card">
        <Link href="/" className="logo" style={{ marginBottom: 18 }}>
          <img src="/logo.svg" alt="" />
          Minuta
        </Link>
        <h1 style={{ fontSize: 22, margin: "12px 0 6px" }}>Entrar al panel</h1>
        <p className="sub" style={{ marginBottom: 16 }}>
          Usa la contraseña del panel que recibiste al instalar Minuta.
        </p>
        {error && (
          <div className="banner err" role="alert">
            {error === "locked" ? "Demasiados intentos. Espera 15 minutos." : "Contraseña incorrecta."}
          </div>
        )}
        <form method="post" action="/api/auth/login" className="settings">
          <label htmlFor="password">Contraseña</label>
          <input id="password" name="password" type="password" required autoFocus autoComplete="current-password" />
          <button type="submit" className="btn" style={{ width: "100%", marginTop: 16 }}>
            Entrar
          </button>
        </form>
      </div>
    </main>
  );
}
