import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, Check, Loader2, LogOut, Mic, Package, Plus, Square, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { startRecording } from "@/lib/recorder";
import { askNotificationPermission, initNotifications, pushNotification } from "@/lib/notify";
import { interpretVoice, type VoiceAction } from "@/lib/voice.functions";

export const Route = createFileRoute("/_authenticated/inventario")({
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

  const products = productsQuery.data ?? [];
  const alerts = alertsQuery.data ?? [];
  const dueAlerts = alerts.filter((a) => new Date(a.due_at).getTime() <= Date.now());

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
          await createAlert(existing, "republish", new Date(Date.now() + WEEK_MS));
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

  const adjust = async (product: Product, delta: number) => {
    const quantity = Math.max(0, product.quantity + delta);
    await supabase.from("products").update({ quantity }).eq("id", product.id);
    if (quantity === 0 && product.quantity > 0) await createAlert(product, "delete", new Date());
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    void queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  const sell = async (product: Product, platform: "wallapop" | "vinted") => {
    if (product.quantity <= 0) return;
    await applyActions([{ type: "sell", name: product.name, platform, quantity: 1 }]);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 pb-40 pt-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Wallapop · Vinted
          </p>
          <h1 className="mt-1 text-3xl font-extrabold leading-tight">Mi stock por voz</h1>
        </div>
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
              <span className="text-foreground">
                «han llegado 3 camisetas vintage a 12 euros»
              </span>
              .
            </p>
          </div>
        )}

        {products.map((product) => (
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
                <span
                  className={`min-w-8 text-center text-xl font-extrabold ${
                    product.quantity === 0 ? "text-destructive" : "text-primary"
                  }`}
                >
                  {product.quantity}
                </span>
                <button
                  onClick={() => adjust(product, 1)}
                  aria-label="Añadir una unidad"
                  className="flex size-8 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                disabled={product.quantity === 0}
                onClick={() => sell(product, "wallapop")}
                className="flex-1 rounded-xl border border-wallapop/40 bg-wallapop/10 py-2 text-xs font-bold text-wallapop disabled:opacity-40"
              >
                Vendido en Wallapop
              </button>
              <button
                disabled={product.quantity === 0}
                onClick={() => sell(product, "vinted")}
                className="flex-1 rounded-xl border border-vinted/40 bg-vinted/10 py-2 text-xs font-bold text-vinted disabled:opacity-40"
              >
                Vendido en Vinted
              </button>
              <button
                onClick={() => applyActions([{ type: "remove", name: product.name }])}
                aria-label="Borrar producto"
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
