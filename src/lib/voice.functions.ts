import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  audioBase64: z.string().min(10),
  products: z.array(
    z.object({
      name: z.string(),
      quantity: z.coerce.number(),
      price: z.coerce.number().nullable().optional(),
    }),
  ),
});

export type VoiceAction =
  | { type: "add"; name: string; quantity: number; price?: number | null }
  | { type: "sell"; name: string; platform: "wallapop" | "vinted" | "almacen"; quantity: number }
  | { type: "set"; name: string; quantity: number }
  | { type: "update_price"; name: string; price: number }
  | { type: "remove"; name: string };

export type VoiceResult = {
  transcript: string;
  actions: VoiceAction[];
  reply: string;
};

const GATEWAY = "https://ai.gateway.lovable.dev/v1";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const interpretVoice = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<VoiceResult> => {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) throw new Error("Falta la configuración de IA");

    const form = new FormData();
    form.append("model", "openai/gpt-4o-mini-transcribe");
    form.append(
      "file",
      new Blob([base64ToBytes(data.audioBase64) as unknown as BlobPart], { type: "audio/wav" }),
      "recording.wav",
    );
    form.append("language", "es");

    const sttRes = await fetch(`${GATEWAY}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!sttRes.ok) {
      const text = await sttRes.text().catch(() => "");
      throw new Error(`No se pudo entender el audio (${sttRes.status}) ${text.slice(0, 200)}`);
    }
    const stt = (await sttRes.json()) as { text?: string };
    const transcript = (stt.text ?? "").trim();
    if (!transcript) {
      return { transcript: "", actions: [], reply: "No he oído nada, prueba otra vez." };
    }

    const productList = data.products.length
      ? data.products
          .map(
            (p) =>
              `- ${p.name}: ${p.quantity} uds${
                p.price != null ? ` a ${p.price}€` : " (sin precio registrado)"
              }`,
          )
          .join("\n")
      : "No hay productos en el inventario todavía.";

    const system = `Eres el asistente de voz de un inventario para vendedores en Wallapop, Vinted y almacén.
Conviertes frases de voz en acciones sobre el stock y respondes preguntas sobre precios, cantidades y disponibilidad.

Inventario actual:
${productList}

Devuelve SOLO un objeto JSON con este formato exacto:
{"actions":[...],"reply":"frase corta y natural en español"}

Acciones posibles en actions (debe ser una lista vacía [] si el usuario solo está preguntando o consultando información):
- {"type":"add","name":"...","quantity":n,"price":n|null} -> Alta de productos nuevos o reposición de stock. Si el usuario indica precio, guárdalo en "price".
- {"type":"sell","name":"...","platform":"wallapop"|"vinted"|"almacen","quantity":n} -> Se ha vendido o enviado a almacén.
- {"type":"set","name":"...","quantity":n} -> Corregir cantidad exacta de stock.
- {"type":"update_price","name":"...","price":n} -> Cambiar o fijar el precio de un producto existente.
- {"type":"remove","name":"..."} -> Borrar un producto del inventario.

REGLAS CRÍTICAS:
1. CONSULTAS DE PRECIO O STOCK: Si el usuario PREGUNTA por el precio, stock o datos de un producto (ej: "¿cuánto cuesta el jersey?", "¿a qué precio tengo las zapatillas?", "¿qué vale X?", "¿cuántas camisetas me quedan?"):
   - Deja actions como [] (NO modifiques el inventario).
   - En "reply", responde con el precio y las unidades disponibles según la lista de inventario actual (ej: "El jersey azul cuesta 15€ y te quedan 2 unidades.").
   - Si el producto existe pero no tiene precio, dilo claramente (ej: "El jersey azul no tiene precio registrado, y te quedan 2 unidades.").
   - Si el producto no existe en el inventario, indícalo amablemente.
2. CAMBIAR O PONER PRECIO: Si el usuario pide cambiar o asignar precio (ej: "Pon el precio del jersey a 20 euros", "Cambia el precio de la sudadera a 15€"), genera {"type":"update_price","name":"...","price":20} y confírmalo en "reply".
3. COINCIDENCIA DE NOMBRES: Si el nombre mencionado por voz se parece a uno existente en la lista, usa EXACTAMENTE el nombre que ya existe en el inventario.
4. CANTIDAD: Si no se indica cantidad en altas o ventas, usa 1 por defecto.
5. PLATAFORMAS EN VENTAS: Usa "wallapop", "vinted" o "almacen". Si indica una venta pero no especifica la plataforma, deja actions como [] y en "reply" pregúntale si se vendió en Wallapop o Vinted.`;

    const chatRes = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.7-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!chatRes.ok) {
      const text = await chatRes.text().catch(() => "");
      throw new Error(`La IA no respondió (${chatRes.status}) ${text.slice(0, 200)}`);
    }
    const chat = (await chatRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = chat.choices?.[0]?.message?.content ?? "{}";
    let parsed: { actions?: VoiceAction[]; reply?: string } = {};
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, ""));
    } catch {
      parsed = {};
    }

    return {
      transcript,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      reply: parsed.reply ?? "Hecho.",
    };
  });
