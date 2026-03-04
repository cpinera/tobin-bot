const express = require("express");
const axios   = require("axios");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;
const TELEGRAM_API    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// In-memory task store (persists while server runs)
let tasks = [];
let taskIdCounter = 1;

// Conversation history per chat
const histories = {};

// ── Telegram helpers ──────────────────────────────────────────
async function sendMessage(chatId, text, parseMode = "Markdown") {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
  }).catch(e => console.error("Send error:", e.response?.data));
}

// ── Task tools ────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_tasks",
    description: "Obtiene todas las tareas del to-do list. Úsala para listar, consultar o buscar tareas.",
    input_schema: {
      type: "object",
      properties: {
        filtro: {
          type: "string",
          description: "Opcional: filtrar por estado (Pendiente, En progreso, Listo) o urgencia (Alta, Media, Baja)"
        }
      }
    }
  },
  {
    name: "create_task",
    description: "Crea una nueva tarea en el to-do list.",
    input_schema: {
      type: "object",
      properties: {
        nombre:   { type: "string",  description: "Nombre o descripción de la tarea" },
        estado:   { type: "string",  description: "Pendiente | En progreso | Listo", enum: ["Pendiente","En progreso","Listo"] },
        urgencia: { type: "string",  description: "Alta | Media | Baja",             enum: ["Alta","Media","Baja"] },
        fecha:    { type: "string",  description: "Fecha límite en formato YYYY-MM-DD (opcional)" },
        monto:    { type: "number",  description: "Monto total (opcional)" },
        cuotas:   { type: "integer", description: "Número de cuotas (opcional, default 1)" }
      },
      required: ["nombre"]
    }
  },
  {
    name: "update_task",
    description: "Actualiza una tarea existente. Úsala para cambiar estado, urgencia, nombre, etc.",
    input_schema: {
      type: "object",
      properties: {
        id:       { type: "integer", description: "ID de la tarea a actualizar" },
        nombre:   { type: "string" },
        estado:   { type: "string", enum: ["Pendiente","En progreso","Listo"] },
        urgencia: { type: "string", enum: ["Alta","Media","Baja"] },
        fecha:    { type: "string" },
        monto:    { type: "number" },
      },
      required: ["id"]
    }
  },
  {
    name: "delete_task",
    description: "Elimina una tarea por su ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "ID de la tarea a eliminar" }
      },
      required: ["id"]
    }
  },
  {
    name: "mark_cuota_pagada",
    description: "Marca una o todas las cuotas de una tarea como pagadas o no pagadas.",
    input_schema: {
      type: "object",
      properties: {
        id:           { type: "integer", description: "ID de la tarea" },
        cuota_numero: { type: "integer", description: "Número de cuota (1, 2, 3...). Si no se especifica, marca todas." },
        pagada:       { type: "boolean", description: "true para pagada, false para no pagada" }
      },
      required: ["id", "pagada"]
    }
  }
];

// ── Tool execution ─────────────────────────────────────────────
function executeTool(name, input) {
  if (name === "get_tasks") {
    let result = [...tasks];
    if (input.filtro) {
      const f = input.filtro;
      result = result.filter(t =>
        t.estado === f || t.urgencia === f ||
        t.nombre.toLowerCase().includes(f.toLowerCase())
      );
    }
    if (result.length === 0) return { ok: true, data: [], message: "No hay tareas." };
    return { ok: true, data: result, total: result.length };
  }

  if (name === "create_task") {
    const numCuotas = input.cuotas || 1;
    const cuotaList = Array.from({ length: numCuotas }, (_, i) => ({
      n: i + 1,
      monto: input.monto ? input.monto / numCuotas : 0,
      pagada: false
    }));
    const task = {
      id:       taskIdCounter++,
      nombre:   input.nombre,
      estado:   input.estado   || "Pendiente",
      urgencia: input.urgencia || "Media",
      fecha:    input.fecha    || "",
      monto:    input.monto    || 0,
      cuotas:   numCuotas,
      cuotaList,
      createdAt: new Date().toISOString()
    };
    tasks.unshift(task);
    return { ok: true, task, message: `Tarea #${task.id} creada.` };
  }

  if (name === "update_task") {
    const idx = tasks.findIndex(t => t.id === input.id);
    if (idx === -1) return { ok: false, message: `No encontré tarea con ID ${input.id}` };
    const fields = ["nombre","estado","urgencia","fecha","monto"];
    fields.forEach(f => { if (input[f] !== undefined) tasks[idx][f] = input[f]; });
    return { ok: true, task: tasks[idx], message: `Tarea #${input.id} actualizada.` };
  }

  if (name === "delete_task") {
    const before = tasks.length;
    tasks = tasks.filter(t => t.id !== input.id);
    if (tasks.length === before) return { ok: false, message: `No encontré tarea con ID ${input.id}` };
    return { ok: true, message: `Tarea #${input.id} eliminada.` };
  }

  if (name === "mark_cuota_pagada") {
    const task = tasks.find(t => t.id === input.id);
    if (!task) return { ok: false, message: `No encontré tarea con ID ${input.id}` };
    if (input.cuota_numero) {
      const c = task.cuotaList.find(c => c.n === input.cuota_numero);
      if (!c) return { ok: false, message: `No existe cuota #${input.cuota_numero}` };
      c.pagada = input.pagada;
    } else {
      task.cuotaList.forEach(c => c.pagada = input.pagada);
    }
    const pagadas = task.cuotaList.filter(c => c.pagada).length;
    return { ok: true, message: `Actualizado. ${pagadas}/${task.cuotaList.length} cuotas pagadas.` };
  }

  return { ok: false, message: "Tool desconocida" };
}

// ── Claude agent loop ──────────────────────────────────────────
async function runAgent(chatId, userMessage) {
  if (!histories[chatId]) histories[chatId] = [];

  histories[chatId].push({ role: "user", content: userMessage });

  // Keep last 20 messages
  if (histories[chatId].length > 20) {
    histories[chatId] = histories[chatId].slice(-20);
  }

  const systemPrompt = `Eres un asistente de productividad personal que gestiona el to-do list del usuario.
Eres conciso, amable y útil. Respondes en español.
Cuando el usuario pida agregar, editar, eliminar o consultar tareas, usa las herramientas disponibles.
Para listar tareas, usa un formato claro con emojis. Ejemplo:
• #1 ✅ *Llamar a Juan* — Alta | 2024-03-10
• #2 🔄 *Reunión* — Media
• #3 ⏳ *Revisar doc* — Baja

Estados: ⏳ Pendiente | 🔄 En progreso | ✅ Listo
Urgencia: 🔴 Alta | 🟡 Media | 🟢 Baja

Si el usuario menciona monto y cuotas, créalas automáticamente divididas en partes iguales.
Siempre confirma las acciones realizadas de forma breve.`;

  let messages = [...histories[chatId]];

  // Agentic loop
  for (let i = 0; i < 5; i++) {
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    }, {
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    });

    const { content, stop_reason } = response.data;
    messages.push({ role: "assistant", content });

    if (stop_reason === "end_turn") {
      const text = content.filter(b => b.type === "text").map(b => b.text).join("\n");
      histories[chatId] = messages;
      return text;
    }

    if (stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const result = executeTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }

  return "Lo siento, no pude completar la acción.";
}

// ── Webhook handler ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Respond immediately to Telegram

  const update = req.body;
  if (!update.message?.text) return;

  const chatId = update.message.chat.id;
  const text   = update.message.text;

  try {
    // Show typing indicator
    await axios.post(`${TELEGRAM_API}/sendChatAction`, {
      chat_id: chatId, action: "typing"
    });

    const reply = await runAgent(chatId, text);
    await sendMessage(chatId, reply);
  } catch (e) {
    console.error("Agent error:", e.response?.data || e.message);
    await sendMessage(chatId, "❌ Ocurrió un error. Intenta de nuevo.");
  }
});

app.get("/", (req, res) => res.send("Bot activo ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
