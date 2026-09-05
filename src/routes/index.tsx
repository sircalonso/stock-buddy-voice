import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Bell, Mic, ShoppingBag } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mi Stock por Voz | Wallapop y Vinted" },
      {
        name: "description",
        content:
          "Controla por voz el stock de tus productos de Wallapop y Vinted: añade lo que llega, resta lo que vendes y recibe avisos para republicar o borrar anuncios.",
      },
      { property: "og:title", content: "Mi Stock por Voz | Wallapop y Vinted" },
      {
        property: "og:description",
        content:
          "Habla y la app actualiza tu inventario: altas, ventas por app y avisos para republicar a la semana o borrar el anuncio al quedarte sin stock.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/inventario", replace: true });
    });
  }, [navigate]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Wallapop · Vinted
        </p>
        <h1 className="mt-2 text-4xl font-extrabold leading-tight">Mi stock por voz</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Habla y listo: da de alta lo que llega, resta lo que vendes y recibe un aviso en el móvil
          para republicar a la semana o borrar el anuncio cuando te quedes a cero.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        <li className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <Mic className="size-5 text-primary" />
          <span className="text-sm">«Han llegado 3 camisetas vintage a 12 euros»</span>
        </li>
        <li className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <ShoppingBag className="size-5 text-primary" />
          <span className="text-sm">«He vendido una camiseta en Vinted»</span>
        </li>
        <li className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <Bell className="size-5 text-primary" />
          <span className="text-sm">Avisos al momento en tu móvil</span>
        </li>
      </ul>

      <Link
        to="/auth"
        className="rounded-2xl bg-primary py-3 text-center text-sm font-bold text-primary-foreground shadow-[var(--shadow-glow)]"
      >
        Entrar
      </Link>
    </main>
  );
}
