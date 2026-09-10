import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Minus, PackageCheck, Plus, Trash2, WifiOff } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { syncSheet } from "@/lib/sheets.functions";

export const Route = createFileRoute("/_authenticated/envio-fba")({
  head: () => ({
    meta: [
      { title: "Reservados para el próximo envío FBA" },
      {
        name: "description",
        content:
          "Lista provisional de los productos que has reservado para el próximo envío FBA. Consúltala sin conexión y confírmala para descontar el stock.",
      },
      { property: "og:title", content: "Reservados para el próximo envío FBA" },
      {
        property: "og:description",
        content:
          "Prepara el próximo envío FBA: revisa las unidades reservadas y confirma el envío para descontarlas del stock.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: EnvioFba,
});

export type Reservation = {
  id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  created_at: string;
};

export const FBA_CACHE_KEY = "fba-reservas";

export function readFbaCache(): Reservation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FBA_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Reservation[]) : [];
  } catch {
    return [];
  }
}

export function writeFbaCache(rows: Reservation[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FBA_CACHE_KEY, JSON.stringify(rows));
  } catch {
    /* almacenamiento lleno o bloqueado */
  }
}

function EnvioFba() {
  const queryClient = useQueryClient();
  const [cached, setCached] = useState<Reservation[]>([]);
  const [offline, setOffline] = useState(false);
  const [sheetState, setSheetState] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    setCached(readFbaCache());
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const reservationsQuery = useQuery({
    queryKey: ["fba-reservations"],
    queryFn: async (): Promise<Reservation[]> => {
      const { data, error } = await supabase
        .from("fba_reservations")
        .select("id,product_id,product_name,quantity,created_at")
        .order("product_name");
      if (error) throw error;
      const rows = (data ?? []) as Reservation[];
      writeFbaCache(rows);
      return rows;
    },
  });

  // Si no hay internet, se muestra la última lista guardada en el móvil.
  const reservations = useMemo(
    () => reservationsQuery.data ?? cached,
    [reservationsQuery.data, cached],
  );
  const usingCache = !reservationsQuery.data && cached.length > 0;
  const totalUnits = reservations.reduce((sum, r) => sum + r.quantity, 0);

  const pushToSheet = async () => {
    setSheetState("saving");
    try {
      await syncSheet();
      setSheetState("ok");
    } catch (err) {
      console.error(err);
      setSheetState("error");
    }
  };

  const changeQuantity = async (row: Reservation, quantity: number) => {
    const value = Math.max(1, Math.round(quantity));
    await supabase.from("fba_reservations").update({ quantity: value }).eq("id", row.id);
    await queryClient.invalidateQueries({ queryKey: ["fba-reservations"] });
    void pushToSheet();
  };

  const removeRow = async (row: Reservation) => {
    await supabase.from("fba_reservations").delete().eq("id", row.id);
    await queryClient.invalidateQueries({ queryKey: ["fba-reservations"] });
    void pushToSheet();
  };

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Sesión caducada");

      const { data: products } = await supabase.from("products").select("id,name,quantity");
      const byId = new Map((products ?? []).map((p) => [p.id, p]));

      for (const row of reservations) {
        const product = row.product_id ? byId.get(row.product_id) : undefined;
        const sent = product ? Math.min(row.quantity, product.quantity) : row.quantity;
        if (sent <= 0 || !row.product_id) continue;

        await supabase.from("sales").insert({
          user_id: userId,
          product_id: row.product_id,
          platform: "fba",
          quantity: sent,
        });


        if (product) {
          const left = Math.max(0, product.quantity - sent);
          await supabase.from("products").update({ quantity: left }).eq("id", product.id);
          if (left === 0) {
            await supabase.from("alerts").insert({
              user_id: userId,
              product_id: product.id,
              product_name: product.name,
              kind: "delete",
              due_at: new Date().toISOString(),
              message: `Te has quedado sin "${product.name}". Bórralo de Wallapop y de Vinted.`,
            });
          }
        }
      }

      await supabase.from("fba_reservations").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      writeFbaCache([]);
      setCached([]);
      return reservations.length;
    },
    onSuccess: async (count) => {
      setDone(`Envío confirmado: ${count} productos pasados a enviados a FBA.`);
      await queryClient.invalidateQueries({ queryKey: ["fba-reservations"] });
      await queryClient.invalidateQueries({ queryKey: ["products"] });
      await queryClient.invalidateQueries({ queryKey: ["sales"] });
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void pushToSheet();
    },
  });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-5 pb-32 pt-10">
      <header className="flex items-center gap-3">
        <Link
          to="/inventario"
          aria-label="Volver al inventario"
          className="rounded-2xl border border-border bg-card p-3 text-muted-foreground shadow-[var(--shadow-card)]"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Próximo envío
          </p>
          <h1 className="text-2xl font-extrabold leading-tight">Reservados para FBA</h1>
        </div>
      </header>

      {(offline || usingCache) && (
        <p className="flex items-center gap-2 rounded-2xl border border-border bg-card/60 p-3 text-xs text-muted-foreground">
          <WifiOff className="size-4" /> Sin conexión: esta es la última lista guardada en el móvil.
        </p>
      )}

      {sheetState !== "idle" && (
        <p className="text-xs text-muted-foreground">
          {sheetState === "saving" && "Guardando también en tu hoja de Google…"}
          {sheetState === "ok" && "Guardado también en tu hoja de Google."}
          {sheetState === "error" && (
            <span className="text-destructive">No he podido escribir en tu hoja de Google.</span>
          )}
        </p>
      )}

      {done && <p className="text-sm font-semibold text-primary">{done}</p>}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
          {reservations.length} productos · {totalUnits} unidades
        </h2>

        {reservations.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Todavía no has reservado nada. En tu stock, toca «Para próximo envío» en los productos
            que quieras mandar a FBA.
          </p>
        )}

        {reservations.map((row) => (
          <article
            key={row.id}
            className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="flex-1 font-semibold leading-snug">{row.product_name}</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => changeQuantity(row, row.quantity - 1)}
                  aria-label="Quitar una unidad"
                  className="flex size-8 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                >
                  <Minus className="size-4" />
                </button>
                <span className="w-8 text-center text-xl font-extrabold text-primary">
                  {row.quantity}
                </span>
                <button
                  onClick={() => changeQuantity(row, row.quantity + 1)}
                  aria-label="Añadir una unidad"
                  className="flex size-8 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                >
                  <Plus className="size-4" />
                </button>
                <button
                  onClick={() => removeRow(row)}
                  aria-label={`Quitar ${row.product_name} de la lista`}
                  className="rounded-xl bg-secondary p-2 text-muted-foreground"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          </article>
        ))}
      </section>

      {reservations.length > 0 && (
        <button
          onClick={() => confirmMutation.mutate()}
          disabled={confirmMutation.isPending || offline}
          className="flex items-center justify-center gap-2 rounded-2xl bg-primary py-4 text-sm font-bold text-primary-foreground shadow-[var(--shadow-glow)] disabled:opacity-50"
        >
          {confirmMutation.isPending ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <PackageCheck className="size-5" />
          )}
          Confirmar envío y descontar del stock
        </button>
      )}

      {confirmMutation.isError && (
        <p className="text-center text-xs text-destructive">
          No he podido confirmar el envío. Inténtalo otra vez con conexión.
        </p>
      )}
    </main>
  );
}
