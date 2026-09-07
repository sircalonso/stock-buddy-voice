import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  audioBase64: z.string().min(10),
  products: z.array(z.object({ name: z.string(), quantity: z.number() })),
});

export type VoiceAction =
  | { type: "add"; name: string; quantity: number; price?: number | null }
  | { type: "sell"; name: string; platform: "wallapop" | "vinted" | "almacen"; quantity: number }
  | { type: "set"; name: string; quantity: number }
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

    const system = `Eres el asistente de un inventario de segunda mano que se vende en Wallapop y Vinted, y que tambien se envia a almacenes.
Conviertes una frase dicha en voz alta en acciones sobre el stock.
Productos actuales (nombre: cantidad): ${
      data.products.length
        ? data.products.map((p) => `${p.name}: ${p.quantity}`).join(", ")
        : "ninguno todavía"
    }.
Devuelve SOLO JSON con esta forma:
{"actions":[...],"reply":"frase corta en español"}
Acciones posibles:
{"type":"add","name":"...","quantity":n,"price":n|null}  -> han llegado productos nuevos o se repone stock
{"type":"sell","name":"...","platform":"wallapop"|"vinted"|"almacen","quantity":n} -> se ha vendido, o se ha enviado a almacenes (platform "almacen")
{"type":"set","name":"...","quantity":n} -> corregir la cantidad exacta
{"type":"remove","name":"..."} -> borrar el producto de la lista
Reglas: si el nombre se parece a uno existente, usa EXACTAMENTE el nombre existente.
Si no se indica cantidad, usa 1. Si no se indica plataforma en una venta, no inventes: usa "sell" solo si se menciona Wallapop, Vinted o el almacén; si no, devuelve actions vacío y pide en "reply" que diga el destino.`;

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
