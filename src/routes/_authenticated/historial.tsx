import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, History, Search, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/historial")({
  head: () => ({
    meta: [
      { title: "Historial de ventas y envíos | Mi Stock" },
      {
        name: "description",
        content:
          "Consulta todo lo que has vendido en Wallapop y Vinted y lo que has enviado a almacenes, con fecha, cantidad y buscador por producto.",
      },
      { property: "og:title", content: "Historial de ventas y envíos | Mi Stock" },
      {
        property: "og:description",
        content:
          "Repasa cada venta de Wallapop y Vinted y cada envío a almacenes de tu inventario de segunda mano.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Historial,
});

type Platform = "wallapop" | "vinted" | "almacen" | "fba";

type SaleRow = {
  id: string;
  platform: Platform;
  quantity: number;
  sold_at: string;
  product_id: string;
  products: { name: string } | null;
};

const LABEL: Record<Platform, string> = {
  wallapop: "Wallapop",
  vinted: "Vinted",
  almacen: "Almacén",
  fba: "Enviado a FBA",
};

const STYLE: Record<Platform, string> = {
  wallapop: "border-wallapop/40 bg-wallapop/10 text-wallapop",
  vinted: "border-vinted/40 bg-vinted/10 text-vinted",
  almacen: "border-warning/40 bg-warning/10 text-warning",
  fba: "border-primary/40 bg-primary/10 text-primary",
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Historial() {
  const [filter, setFilter] = useState<"todo" | Platform>("todo");
  const [search, setSearch] = useState("");

  const salesQuery = useQuery({
    queryKey: ["sales"],
    queryFn: async (): Promise<SaleRow[]> => {
      const { data, error } = await supabase
        .from("sales")
        .select("id,platform,quantity,sold_at,product_id,products(name)")
        .order("sold_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SaleRow[];
    },
  });

  const sales = useMemo(() => salesQuery.data ?? [], [salesQuery.data]);

  const totals = useMemo(() => {
    const base: Record<Platform, number> = { wallapop: 0, vinted: 0, almacen: 0, fba: 0 };
    for (const sale of sales) base[sale.platform] = (base[sale.platform] ?? 0) + sale.quantity;
    return base;
  }, [sales]);

  const visible = useMemo(() => {
    const q = normalize(search);
    return sales.filter((s) => {
      if (filter !== "todo" && s.platform !== filter) return false;
      if (!q) return true;
      return normalize(s.products?.name ?? "").includes(q);
    });
  }, [sales, filter, search]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 pb-24 pt-10">
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
            Ya salió del stock
          </p>
          <h1 className="mt-1 text-3xl font-extrabold leading-tight">Historial</h1>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-2">
        {(Object.keys(LABEL) as Platform[]).map((key) => (
          <div
            key={key}
            className={`rounded-2xl border p-3 text-center shadow-[var(--shadow-card)] ${STYLE[key]}`}
          >
            <p className="text-2xl font-extrabold">{totals[key]}</p>
            <p className="text-[11px] font-bold">{LABEL[key]}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar un producto…"
            aria-label="Buscar un producto en el historial"
            className="w-full rounded-2xl border border-border bg-card py-3 pl-10 pr-10 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label="Borrar búsqueda"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <div className="flex gap-2">
          {(["todo", "wallapop", "vinted", "almacen", "fba"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`flex-1 rounded-xl border py-2 text-[11px] font-bold ${
                filter === key
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              {key === "todo" ? "Todo" : LABEL[key]}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        {salesQuery.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}

        {!salesQuery.isLoading && visible.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-[var(--shadow-card)]">
            <History className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              Aquí aparecerá todo lo que vendas en Wallapop o Vinted y lo que envíes a almacenes.
            </p>
          </div>
        )}

        {visible.map((sale) => (
          <article
            key={sale.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]"
          >
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold">
                {sale.products?.name ?? "Producto borrado"}
              </h2>
              <p className="text-xs text-muted-foreground">{formatDate(sale.sold_at)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-bold">×{sale.quantity}</span>
              <span
                className={`rounded-lg border px-2 py-1 text-[11px] font-bold ${STYLE[sale.platform]}`}
              >
                {LABEL[sale.platform]}
              </span>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
