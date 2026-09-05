import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, Mic } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Entrar en Mi Stock por Voz" },
      {
        name: "description",
        content:
          "Entra con tu correo o con Google para gestionar por voz el stock de tus productos de Wallapop y Vinted de forma privada.",
      },
      { property: "og:title", content: "Entrar en Mi Stock por Voz" },
      {
        property: "og:description",
        content: "Accede a tu inventario privado de Wallapop y Vinted controlado por voz.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/inventario", replace: true });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) navigate({ to: "/inventario", replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (err) throw err;
        if (!data.session) setInfo("Te hemos enviado un correo. Ábrelo para confirmar tu cuenta.");
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
      <div className="text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[var(--shadow-glow)]">
          <Mic className="size-7" />
        </div>
        <h1 className="mt-5 text-3xl font-extrabold leading-tight">Mi stock por voz</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Entra para que tu inventario de Wallapop y Vinted sea solo tuyo.
        </p>
      </div>

      <button
        onClick={() =>
          lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin })
        }
        className="w-full rounded-2xl border border-border bg-card py-3 text-sm font-bold shadow-[var(--shadow-card)]"
      >
        Continuar con Google
      </button>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Tu correo"
          className="rounded-2xl border border-border bg-card px-4 py-3 text-sm outline-none focus:border-primary"
        />
        <input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Tu contraseña"
          className="rounded-2xl border border-border bg-card px-4 py-3 text-sm outline-none focus:border-primary"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {info && <p className="text-xs text-muted-foreground">{info}</p>}
        <button
          type="submit"
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-sm font-bold text-primary-foreground disabled:opacity-60"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {mode === "signin" ? "Entrar" : "Crear cuenta"}
        </button>
      </form>

      <button
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setInfo(null);
        }}
        className="text-center text-xs text-muted-foreground underline"
      >
        {mode === "signin" ? "No tengo cuenta todavía" : "Ya tengo cuenta"}
      </button>
    </main>
  );
}
