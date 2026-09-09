import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";
const SPREADSHEET_ID = "1odIesSnlh16zP035ddzpdn8xAoONderyAcwQlQtAziI";
const STOCK_TAB = "App Stock";
const MOVES_TAB = "App Movimientos";
const FBA_TAB = "App Reservado FBA";


function headers() {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const connectionKey = process.env["GOOGLE_SHEETS_API_KEY"];
  if (!lovableKey || !connectionKey) throw new Error("Falta la conexión con Google Sheets");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": connectionKey,
    "Content-Type": "application/json",
  };
}

async function sheetsFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[sheets] ${res.status} ${body}`);
    throw new Error(`Google Sheets falló (${res.status}) ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function ensureTabs() {
  const meta = (await sheetsFetch(
    `/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties.title`,
  )) as { sheets?: Array<{ properties?: { title?: string } }> };
  const titles = new Set((meta.sheets ?? []).map((s) => s.properties?.title));
  const missing = [STOCK_TAB, MOVES_TAB, FBA_TAB].filter((t) => !titles.has(t));

  if (missing.length === 0) return;
  await sheetsFetch(`/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    }),
  });
}

async function writeTab(tab: string, values: (string | number)[][]) {
  await sheetsFetch(
    `/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1:Z10000:clear`,
    { method: "POST", body: "{}" },
  );
  await sheetsFetch(
    `/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(tab)}!A1?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: JSON.stringify({ values }) },
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  wallapop: "Wallapop",
  vinted: "Vinted",
  almacen: "Almacén",
};

function fmt(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const syncSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;

    const [{ data: products, error: pErr }, { data: sales, error: sErr }] = await Promise.all([
      supabase.from("products").select("name,quantity,price,updated_at").order("name"),
      supabase
        .from("sales")
        .select("platform,quantity,sold_at,products(name)")
        .order("sold_at", { ascending: false })
        .limit(2000),
    ]);
    if (pErr) throw pErr;
    if (sErr) throw sErr;

    await ensureTabs();

    const stockRows: (string | number)[][] = [
      ["Producto", "Cantidad", "Precio", "Actualizado"],
      ...(products ?? []).map((p) => [
        p.name,
        p.quantity,
        p.price ?? "",
        fmt(p.updated_at),
      ]),
    ];

    const moveRows: (string | number)[][] = [
      ["Fecha", "Producto", "Destino", "Cantidad"],
      ...(sales ?? []).map((s) => {
        const rel = s.products as unknown as { name?: string } | { name?: string }[] | null;
        const name = Array.isArray(rel) ? (rel[0]?.name ?? "") : (rel?.name ?? "");
        return [fmt(s.sold_at), name, PLATFORM_LABEL[s.platform] ?? s.platform, s.quantity];
      }),
    ];

    await writeTab(STOCK_TAB, stockRows);
    await writeTab(MOVES_TAB, moveRows);

    return { products: (products ?? []).length, moves: (sales ?? []).length };
  });
