const express = require("express");
const axios   = require("axios");

const app = express();
app.use(express.json());

// CORS - permite que la app web se conecte
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const API_SECRET     = process.env.API_SECRET || "tobin2024";
const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let tasks = [];
let taskIdCounter = 1;
const histories = {};

// ── Auth middleware para endpoints REST ───────────────────────
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── REST API endpoints ────────────────────────────────────────
app.get("/tasks", auth, (req, res) => {
  res.json({ tasks, total: tasks.length });
});

app.post("/tasks", auth, (req, res) => {
  const { nombre, estado, urgencia, fecha, monto, cuotas } = req.body;
  if (!nombre) return res.status(400).json({ error: "nombre requerido" });
  const numCuotas = cuotas || 1;
  const task = {
    id: taskIdCounter++,
    nombre,
    estado:   estado   || "Pendiente",
    urgencia: urgencia || "Media",
    fecha:    fecha    || "",
    monto:    monto    || 0,
    cuotas:   numCuotas,
    cuotaList: Array.from({ length: numCuotas }, (_,i) => ({ n:i+1, monto: monto ? monto/numCuotas : 0, pagada:false })),
    createdAt: new Date().toISOString()
  };
  tasks.unshift(task);
  res.json({ ok: true, task });
});

app.patch("/tasks/:id", auth, (req, res) => {
  const id  = parseInt(req.params.id);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: "No encontrada" });
  ["nombre","estado","urgencia","fecha","monto","cuotaList"].forEach(f => {
    if (req.body[f] !== undefined) tasks[idx][f] = req.body[f];
  });
  res.json({ ok: true, task: tasks[idx] });
});

app.delete("/tasks/:id", auth, (req, res) => {
  const id = parseInt(req.params.id);
  const before = tasks.length;
  tasks = tasks.filter(t => t.id !== id);
  if (tasks.length === before) return res.status(404).json({ error: "No encontrada" });
  res.json({ ok: true });
});

// ── Telegram helpers ──────────────────────────────────────────
async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId, text, parse_mode: "Markdown",
  }).catch(e => console.error("Send error:", e.response?.data));
}

// ── Tools ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_tasks",
    description: "Obtiene todas las tareas del to-do list.",
    input_schema: { type:"object", properties: { filtro: { type:"string" } } }
  },
  {
    name: "create_task",
    description: "Crea una nueva tarea. Llama UNA VEZ POR CADA tarea.",
    input_schema: {
      type: "object",
      properties: {
        nombre:   { type:"string" },
        estado:   { type:"string", enum:["Pendiente","En progreso","Listo"] },
        urgencia: { type:"string", enum:["Alta","Media","Baja"] },
        fecha:    { type:"string" },
        monto:    { type:"number" },
        cuotas:   { type:"integer" }
      },
      required: ["nombre"]
    }
  },
  {
    name: "update_task",
    description: "Actualiza una tarea existente.",
    input_schema: {
      type: "object",
      properties: {
        id:       { type:"integer" },
        nombre:   { type:"string" },
        estado:   { type:"string", enum:["Pendiente","En progreso","Listo"] },
        urgencia: { type:"string", enum:["Alta","Media","Baja"] },
        fecha:    { type:"string" },
        monto:    { type:"number" }
      },
      required: ["id"]
    }
  },
  {
    name: "delete_task",
    description: "Elimina una tarea por ID.",
    input_schema: { type:"object", properties: { id: { type:"integer" } }, required:["id"] }
  },
  {
    name: "mark_cuota_pagada",
    description: "Marca cuotas como pagadas.",
    input_schema: {
      type: "object",
      properties: {
        id:           { type:"integer" },
        cuota_numero: { type:"integer" },
        pagada:       { type:"boolean" }
      },
      required: ["id","pagada"]
    }
  }
];

function executeTool(name, input) {
  if (name === "get_tasks") {
    let result = [...tasks];
    if (input.filtro) {
      const f = input.filtro;
      result = result.filter(t => t.estado===f || t.urgencia===f || t.nombre.toLowerCase().includes(f.toLowerCase()));
    }
    return { ok:true, data:result, total:result.length };
  }
  if (name === "create_task") {
    const numCuotas = input.cuotas || 1;
    const task = {
      id: taskIdCounter++,
      nombre:   input.nombre,
      estado:   input.estado   || "Pendiente",
      urgencia: input.urgencia || "Media",
      fecha:    input.fecha    || "",
      monto:    input.monto    || 0,
      cuotas:   numCuotas,
      cuotaList: Array.from({ length:numCuotas }, (_,i) => ({ n:i+1, monto: input.monto ? input.monto/numCuotas : 0, pagada:false })),
      createdAt: new Date().toISOString()
    };
    tasks.unshift(task);
    return { ok:true, task, message:`Tarea #${task.id} "${task.nombre}" creada.` };
  }
  if (name === "update_task") {
    const idx = tasks.findIndex(t => t.id === input.id);
    if (idx === -1) return { ok:false, message:`No encontré tarea #${input.id}` };
    ["nombre","estado","urgencia","fecha","monto"].forEach(f => { if (input[f] !== undefined) tasks[idx][f] = input[f]; });
    return { ok:true, task:tasks[idx], message:`Tarea #${input.id} actualizada.` };
  }
  if (name === "delete_task") {
    const before = tasks.length;
    tasks = tasks.filter(t => t.id !== input.id);
    return tasks.length < before ? { ok:true, message:`Eliminada.` } : { ok:false, message:`No encontré #${input.id}` };
  }
  if (name === "mark_cuota_pagada") {
    const task = tasks.find(t => t.id === input.id);
    if (!task) return { ok:false, message:`No encontré #${input.id}` };
    if (input.cuota_numero) {
      const c = task.cuotaList.find(c => c.n === input.cuota_numero);
      if (c) c.pagada = input.pagada;
    } else {
      task.cuotaList.forEach(c => c.pagada = input.pagada);
    }
    return { ok:true, message:`${task.cuotaList.filter(c=>c.pagada).length}/${task.cuotaList.length} cuotas pagadas.` };
  }
  return { ok:false, message:"Tool desconocida" };
}

function cleanHistory(msgs, maxPairs = 5) {
  const clean = [];
  for (const msg of msgs) {
    if (typeof msg.content === "string" && msg.content.trim()) clean.push(msg);
  }
  return clean.slice(-(maxPairs * 2));
}

async function runAgent(chatId, userMessage) {
  if (!histories[chatId]) histories[chatId] = [];
  const systemPrompt = `Eres un asistente de productividad personal que gestiona el to-do list del usuario.
Eres conciso, amable y respondes en español.
Para listar tareas usa este formato:
• #ID EMOJI *Nombre* — URGENCIA
Estados: ⏳ Pendiente | 🔄 En progreso | ✅ Listo
Urgencia: 🔴 Alta | 🟡 Media | 🟢 Baja
Cuando el usuario pida agregar MÚLTIPLES tareas, llama create_task individualmente por cada una.
Confirma las acciones brevemente.`;

  const safeHistory = cleanHistory(histories[chatId]);
  let messages = [...safeHistory, { role:"user", content:userMessage }];

  for (let i = 0; i < 25; i++) {
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
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
    messages.push({ role:"assistant", content });

    if (stop_reason === "end_turn") {
      const text = content.filter(b => b.type==="text").map(b => b.text).join("\n");
      histories[chatId] = cleanHistory([
        ...safeHistory,
        { role:"user",      content:userMessage },
        { role:"assistant", content:text }
      ]);
      return text || "✓ Listo.";
    }

    if (stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const result = executeTool(block.name, block.input);
          toolResults.push({ type:"tool_result", tool_use_id:block.id, content:JSON.stringify(result) });
        }
      }
      messages.push({ role:"user", content:toolResults });
    }
  }
  return "No pude completar la acción, intenta de nuevo.";
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message?.text) return;
  const chatId = update.message.chat.id;
  const text   = update.message.text;
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id:chatId, action:"typing" });
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
