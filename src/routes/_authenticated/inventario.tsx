import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellRing,
  Check,
  History,
  ListPlus,
  Loader2,
  LogOut,
  Mic,
  Package,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { startRecording } from "@/lib/recorder";
import { askNotificationPermission, initNotifications, pushNotification } from "@/lib/notify";
import { interpretVoice, type VoiceAction } from "@/lib/voice.functions";
import { syncSheet } from "@/lib/sheets.functions";

export const Route = createFileRoute("/_authenticated/inventario")({
  head: () => ({
    meta: [
      { title: "Mi Stock por Voz | Wallapop y Vinted" },
      {
        name: "description",
        content:
          "Controla por voz o a mano el stock de tus productos de Wallapop, Vinted y almacén: añade, busca, resta y recibe avisos para republicar o borrar anuncios.",
      },
      { property: "og:title", content: "Mi Stock por Voz | Wallapop y Vinted" },
      {
        property: "og:description",
        content:
          "Habla o escribe y la app actualiza tu inventario: altas, ventas por app, envíos a almacén y avisos para republicar o borrar el anuncio.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Product = {
  id: string;
  name: string;
  quantity: number;
  price: number | null;
  updated_at: string;
};

type Alert = {
  id: string;
  product_id: string | null;
  product_name: string;
  kind: "republish" | "delete";
  message: string;
  due_at: string;
  notified_at: string | null;
  done: boolean;
};

type Platform = "wallapop" | "vinted" | "almacen";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Convierte una lista pegada en filas de producto. Acepta separadores , ; tab o varios espacios. */
function parseList(text: string) {
  const rows: Array<{ name: string; quantity: number; price: number | null }> = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    const parts = clean.split(/\s*[,;\t|]\s*|\s{2,}/).filter(Boolean);
    let name = parts[0] ?? clean;
    let quantity = 1;
    let price: number | null = null;

    const numbers = parts.slice(1).map((p) => Number(p.replace(/[^\d.,-]/g, "").replace(",", ".")));
    const valid = numbers.filter((n) => Number.isFinite(n));
    if (valid.length >= 1) quantity = Math.max(0, Math.round(valid[0]!));
    if (valid.length >= 2) price = valid[1]!;

    // "3 camisetas" o "camisetas x3"
    if (parts.length === 1) {
      const lead = clean.match(/^(\d+)\s*[xX]?\s+(.*)$/);
      const trail = clean.match(/^(.*?)\s*[xX]\s*(\d+)$/);
      if (lead) {
        quantity = Number(lead[1]);
        name = lead[2]!.trim();
      } else if (trail) {
        name = trail[1]!.trim();
        quantity = Number(trail[2]);
      }
    }

    if (!name) continue;
    rows.push({ name, quantity, price });
  }
  return rows;
}

function Index() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = Route.useRouteContext();
  const userId = user.id;

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ heard: string; reply: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const recorderRef = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null);

  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [newName, setNewName] = useState("");
  const [newQty, setNewQty] = useState("1");
  const [newPrice, setNewPrice] = useState("");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const productsQuery = useQuery({
    queryKey: ["products"],
    queryFn: async (): Promise<Product[]> => {
      const { data, error: err } = await supabase
        .from("products")
        .select("id,name,quantity,price,updated_at")
        .order("name");
      if (err) throw err;
      return (data ?? []) as Product[];
    },
  });

  const alertsQuery = useQuery({
    queryKey: ["alerts"],
    queryFn: async (): Promise<Alert[]> => {
      const { data, error: err } = await supabase
        .from("alerts")
        .select("id,product_id,product_name,kind,message,due_at,notified_at,done")
        .eq("done", false)
        .order("due_at");
      if (err) throw err;
      return (data ?? []) as Alert[];
    },
    refetchInterval: 30000,
  });

  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data]);
  const alerts = useMemo(() => alertsQuery.data ?? [], [alertsQuery.data]);
  const dueAlerts = alerts.filter((a) => new Date(a.due_at).getTime() <= Date.now());

  const visibleProducts = useMemo(() => {
    const q = normalize(search);
    if (!q) return products;
    return products.filter((p) => normalize(p.name).includes(q));
  }, [products, search]);

  useEffect(() => {
    void initNotifications().then(setPermission);
  }, []);

  // Lanza el aviso del móvil en cuanto un recordatorio llega a su fecha.
  useEffect(() => {
    const pending = alerts.filter(
      (a) => !a.notified_at && new Date(a.due_at).getTime() <= Date.now(),
    );
    if (pending.length === 0) return;
    void (async () => {
      for (const alert of pending) {
        await pushNotification(
          alert.kind === "delete" ? "Sin stock: borra el anuncio" : "Toca republicar",
          alert.message,
          alert.id,
        );
      }
      await supabase
        .from("alerts")
        .update({ notified_at: new Date().toISOString() })
        .in(
          "id",
          pending.map((a) => a.id),
        );
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
    })();
  }, [alerts, queryClient]);

  // Copia el stock y los movimientos a la hoja de Google después de cada cambio.
  const pushToSheet = useCallback(async () => {
    setSheetState("saving");
    try {
      await syncSheet();
      setSheetState("ok");
    } catch (err) {
      console.error(err);
      setSheetState("error");
    }
  }, []);

  const createAlert = useCallback(
    async (product: { id: string; name: string }, kind: Alert["kind"], dueAt: Date) => {
      await supabase.from("alerts").insert({
        user_id: userId,
        product_id: product.id,
        product_name: product.name,
        kind,
        due_at: dueAt.toISOString(),
        message:
          kind === "delete"
            ? `Te has quedado sin "${product.name}". Bórralo de Wallapop y de Vinted.`
            : `Ha pasado una semana desde que vendiste "${product.name}". Vuelve a publicarlo.`,
      });
    },
    [userId],
  );

  const applyActions = useCallback(
    async (actions: VoiceAction[]) => {
      const current = [...products];
      const find = (name: string) =>
        current.find((p) => normalize(p.name) === normalize(name)) ??
        current.find(
          (p) => normalize(p.name).includes(normalize(name)) || normalize(name).includes(normalize(p.name)),
        );

      for (const action of actions) {
        if (action.type === "add") {
          const existing = find(action.name);
          if (existing) {
            const quantity = existing.quantity + (action.quantity || 1);
            await supabase
              .from("products")
              .update({
                quantity,
                ...(action.price != null ? { price: action.price } : {}),
              })
              .eq("id", existing.id);
            existing.quantity = quantity;
          } else {
            const { data } = await supabase
              .from("products")
              .insert({
                user_id: userId,
                name: action.name,
                quantity: action.quantity || 1,
                price: action.price ?? null,
              })
              .select("id,name,quantity,price,updated_at")
              .single();
            if (data) current.push(data as Product);
          }
        }

        if (action.type === "sell") {
          const existing = find(action.name);
          if (!existing) continue;
          const sold = Math.min(action.quantity || 1, existing.quantity);
          const quantity = Math.max(0, existing.quantity - sold);
          await supabase.from("products").update({ quantity }).eq("id", existing.id);
          await supabase.from("sales").insert({
            user_id: userId,
            product_id: existing.id,
            platform: action.platform,
            quantity: sold || 1,
          });
          existing.quantity = quantity;
          // Enviar a almacén no necesita republicar el anuncio.
          if (action.platform !== "almacen") {
            await createAlert(existing, "republish", new Date(Date.now() + WEEK_MS));
          }
          if (quantity === 0) {
            await createAlert(existing, "delete", new Date());
          }
        }

        if (action.type === "set") {
          const existing = find(action.name);
          if (!existing) continue;
          await supabase.from("products").update({ quantity: action.quantity }).eq("id", existing.id);
          if (action.quantity === 0) await createAlert(existing, "delete", new Date());
          existing.quantity = action.quantity;
        }

        if (action.type === "remove") {
          const existing = find(action.name);
          if (!existing) continue;
          await supabase.from("products").delete().eq("id", existing.id);
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["products"] });
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
      await queryClient.invalidateQueries({ queryKey: ["sales"] });
    },
    [products, createAlert, queryClient, userId],
  );

  const voiceMutation = useMutation({
    mutationFn: async (audioBase64: string) => {
      const result = await interpretVoice({
        data: { audioBase64, products: products.map((p) => ({ name: p.name, quantity: p.quantity })) },
      });
      await applyActions(result.actions);
      return result;
    },
    onSuccess: (result) => setFeedback({ heard: result.transcript, reply: result.reply }),
    onError: (err: Error) => setError(err.message),
  });

  const toggleRecording = async () => {
    setError(null);
    if (recording) {
      setRecording(false);
      setBusy(true);
      try {
        const audio = await recorderRef.current!.stop();
        recorderRef.current = null;
        await voiceMutation.mutateAsync(audio);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      if (permission === "default") setPermission(await askNotificationPermission());
      recorderRef.current = await startRecording();
      setFeedback(null);
      setRecording(true);
    } catch {
      setError("No he podido usar el micrófono. Revisa los permisos del navegador.");
    }
  };

  const markAlertDone = async (id: string) => {
    await supabase.from("alerts").update({ done: true }).eq("id", id);
    void queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  const setQuantity = async (product: Product, quantity: number) => {
    const value = Math.max(0, Math.round(quantity));
    if (value === product.quantity) return;
    await supabase.from("products").update({ quantity: value }).eq("id", product.id);
    if (value === 0 && product.quantity > 0) await createAlert(product, "delete", new Date());
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    void queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  const adjust = (product: Product, delta: number) => setQuantity(product, product.quantity + delta);

  const sell = async (product: Product, platform: Platform) => {
    if (product.quantity <= 0) return;
    await applyActions([{ type: "sell", name: product.name, platform, quantity: 1 }]);
  };

  const addProduct = async () => {
    const name = newName.trim();
    if (!name) return;
    const quantity = Math.max(0, Math.round(Number(newQty) || 0));
    const price = newPrice.trim() ? Number(newPrice.replace(",", ".")) : null;
    await supabase.from("products").insert({
      user_id: userId,
      name,
      quantity,
      price: Number.isFinite(price as number) ? price : null,
    });
    setNewName("");
    setNewQty("1");
    setNewPrice("");
    setShowAdd(false);
    void queryClient.invalidateQueries({ queryKey: ["products"] });
  };

  const importList = async () => {
    const rows = parseList(importText);
    if (rows.length === 0) return;
    setImporting(true);
    try {
      const byName = new Map(products.map((p) => [normalize(p.name), p]));
      const toInsert: Array<{ user_id: string; name: string; quantity: number; price: number | null }> = [];
      for (const row of rows) {
        const existing = byName.get(normalize(row.name));
        if (existing) {
          await supabase
            .from("products")
            .update({ quantity: row.quantity, ...(row.price != null ? { price: row.price } : {}) })
            .eq("id", existing.id);
        } else {
          toInsert.push({ user_id: userId, name: row.name, quantity: row.quantity, price: row.price });
        }
      }
      if (toInsert.length > 0) await supabase.from("products").insert(toInsert);
      setImportText("");
      setImportDone(`Añadidos ${rows.length} productos de tu lista.`);
      setShowImport(false);
      void queryClient.invalidateQueries({ queryKey: ["products"] });
    } finally {
      setImporting(false);
    }
  };

  const inputClass =
    "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 pb-40 pt-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Wallapop · Vinted · Almacén
          </p>
          <h1 className="mt-1 text-3xl font-extrabold leading-tight">Mi stock por voz</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/historial"
            aria-label="Ver historial de ventas y envíos"
            className="rounded-2xl border border-border bg-card p-3 text-muted-foreground shadow-[var(--shadow-card)]"
          >
            <History className="size-5" />
          </Link>
          <button
            onClick={async () => {
              await queryClient.cancelQueries();
              queryClient.clear();
              await supabase.auth.signOut();
              navigate({ to: "/auth", replace: true });
            }}
            aria-label="Cerrar sesión"
            className="rounded-2xl border border-border bg-card p-3 text-muted-foreground shadow-[var(--shadow-card)]"
          >
            <LogOut className="size-5" />
          </button>
          <div className="relative rounded-2xl border border-border bg-card p-3 shadow-[var(--shadow-card)]">
            {dueAlerts.length > 0 ? (
              <BellRing className="size-5 text-accent" />
            ) : (
              <Bell className="size-5 text-muted-foreground" />
            )}
            {dueAlerts.length > 0 && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-destructive text-[11px] font-bold text-destructive-foreground">
                {dueAlerts.length}
              </span>
            )}
          </div>
        </div>
      </header>

      {permission !== "granted" && (
        <button
          onClick={async () => setPermission(await askNotificationPermission())}
          className="rounded-2xl border border-dashed border-border bg-card/60 p-4 text-left text-sm text-muted-foreground"
        >
          <span className="font-semibold text-foreground">Activa los avisos del móvil</span>
          <br />
          Toca aquí para permitir las notificaciones y enterarte al momento cuando un producto se
          queda a cero o toca republicar.
        </button>
      )}

      {dueAlerts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Avisos</h2>
          {dueAlerts.map((alert) => (
            <article
              key={alert.id}
              className={`flex items-start gap-3 rounded-2xl border p-4 shadow-[var(--shadow-card)] ${
                alert.kind === "delete"
                  ? "border-destructive/50 bg-destructive/10"
                  : "border-warning/40 bg-warning/10"
              }`}
            >
              <p className="flex-1 text-sm leading-snug">{alert.message}</p>
              <button
                onClick={() => markAlertDone(alert.id)}
                aria-label="Marcar como hecho"
                className="rounded-xl bg-secondary p-2 text-secondary-foreground"
              >
                <Check className="size-4" />
              </button>
            </article>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar un producto…"
            aria-label="Buscar un producto"
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
          <button
            onClick={() => {
              setShowAdd((v) => !v);
              setShowImport(false);
            }}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-card py-2 text-xs font-bold"
          >
            <Plus className="size-4" /> Añadir producto
          </button>
          <button
            onClick={() => {
              setShowImport((v) => !v);
              setShowAdd(false);
            }}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-card py-2 text-xs font-bold"
          >
            <ListPlus className="size-4" /> Importar lista
          </button>
        </div>

        {showAdd && (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nombre del producto"
              aria-label="Nombre del producto"
              className={inputClass}
            />
            <div className="flex gap-2">
              <input
                value={newQty}
                onChange={(e) => setNewQty(e.target.value)}
                inputMode="numeric"
                placeholder="Cantidad"
                aria-label="Cantidad"
                className={inputClass}
              />
              <input
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                inputMode="decimal"
                placeholder="Precio €"
                aria-label="Precio en euros"
                className={inputClass}
              />
            </div>
            <button
              onClick={addProduct}
              className="rounded-xl bg-primary py-2 text-sm font-bold text-primary-foreground"
            >
              Guardar producto
            </button>
          </div>
        )}

        {showImport && (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <p className="text-xs text-muted-foreground">
              Pega tu lista, un producto por línea. Puedes poner{" "}
              <span className="text-foreground">nombre, cantidad, precio</span> — por ejemplo{" "}
              <span className="text-foreground">Camiseta vintage, 3, 12</span>.
            </p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={7}
              placeholder={"Camiseta vintage, 3, 12\nVaqueros Levis, 1, 25\nBolso cuero"}
              aria-label="Lista de productos"
              className={`${inputClass} resize-y font-mono`}
            />
            <button
              onClick={importList}
              disabled={importing || !importText.trim()}
              className="flex items-center justify-center gap-2 rounded-xl bg-primary py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Añadir {parseList(importText).length || ""} productos
            </button>
          </div>
        )}

        {importDone && (
          <p className="rounded-xl bg-primary/10 px-3 py-2 text-xs text-primary">{importDone}</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Tus productos
        </h2>

        {productsQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Cargando tu inventario…</p>
        )}

        {!productsQuery.isLoading && products.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-[var(--shadow-card)]">
            <Package className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              Todavía no hay nada. Pulsa el micrófono y di algo como{" "}
              <span className="text-foreground">«han llegado 3 camisetas vintage a 12 euros»</span>, o
              usa «Importar lista» para pegar el stock que ya tienes.
            </p>
          </div>
        )}

        {!productsQuery.isLoading && products.length > 0 && visibleProducts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No hay ningún producto que se llame así.
          </p>
        )}

        {visibleProducts.map((product) => (
          <article
            key={product.id}
            className="rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-card)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold">{product.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {product.price != null ? `${Number(product.price).toFixed(2)} € · ` : ""}
                  actualizado {formatDate(product.updated_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => adjust(product, -1)}
                  aria-label="Quitar una unidad"
                  className="size-8 rounded-lg bg-secondary text-lg leading-none text-secondary-foreground"
                >
                  –
                </button>
                <input
                  value={editing?.id === product.id ? editing.value : String(product.quantity)}
                  onChange={(e) => setEditing({ id: product.id, value: e.target.value })}
                  onFocus={() => setEditing({ id: product.id, value: String(product.quantity) })}
                  onBlur={async () => {
                    const value = Number(editing?.value);
                    setEditing(null);
                    if (Number.isFinite(value)) await setQuantity(product, value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  inputMode="numeric"
                  aria-label={`Cantidad de ${product.name}`}
                  className={`w-12 rounded-lg bg-background text-center text-xl font-extrabold outline-none focus:ring-2 focus:ring-primary ${
                    product.quantity === 0 ? "text-destructive" : "text-primary"
                  }`}
                />
                <button
                  onClick={() => adjust(product, 1)}
                  aria-label="Añadir una unidad"
                  className="flex size-8 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                disabled={product.quantity === 0}
                onClick={() => sell(product, "wallapop")}
                className="rounded-xl border border-wallapop/40 bg-wallapop/10 py-2 text-[11px] font-bold text-wallapop disabled:opacity-40"
              >
                Wallapop
              </button>
              <button
                disabled={product.quantity === 0}
                onClick={() => sell(product, "vinted")}
                className="rounded-xl border border-vinted/40 bg-vinted/10 py-2 text-[11px] font-bold text-vinted disabled:opacity-40"
              >
                Vinted
              </button>
              <button
                disabled={product.quantity === 0}
                onClick={() => sell(product, "almacen")}
                className="rounded-xl border border-warning/40 bg-warning/10 py-2 text-[11px] font-bold text-warning disabled:opacity-40"
              >
                A almacén
              </button>
            </div>

            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Vendido o enviado</span>
              <button
                onClick={() => applyActions([{ type: "remove", name: product.name }])}
                aria-label={`Borrar ${product.name}`}
                className="rounded-xl bg-secondary p-2 text-muted-foreground"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          </article>
        ))}
      </section>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-5 pb-8 pt-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3">
          {error && <p className="text-center text-xs text-destructive">{error}</p>}
          {feedback && !error && (
            <div className="w-full rounded-2xl bg-card p-3 text-center">
              <p className="text-xs text-muted-foreground">«{feedback.heard}»</p>
              <p className="mt-1 text-sm font-semibold">{feedback.reply}</p>
            </div>
          )}
          <button
            onClick={toggleRecording}
            disabled={busy}
            className={`flex size-20 items-center justify-center rounded-full transition-transform active:scale-95 ${
              recording
                ? "recording-pulse bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground shadow-[var(--shadow-glow)]"
            } disabled:opacity-60`}
            aria-label={recording ? "Parar y enviar" : "Hablar"}
          >
            {busy ? (
              <Loader2 className="size-8 animate-spin" />
            ) : recording ? (
              <Square className="size-7 fill-current" />
            ) : (
              <Mic className="size-8" />
            )}
          </button>
          <p className="text-xs text-muted-foreground">
            {busy
              ? "Entendiendo lo que has dicho…"
              : recording
                ? "Te escucho… toca para terminar"
                : "Toca y habla"}
          </p>
        </div>
      </div>
    </main>
  );
}
