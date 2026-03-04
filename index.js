const express = require("express");
const axios   = require("axios");

const app = express();
app.use(express.json());

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
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SUPA_HEADERS   = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };

const histories = {};

// ── Supabase helpers ──────────────────────────────────────────
async function dbGetAll() {
  const res = await axios.get(`${SUPABASE_URL}/rest/v1/tasks?order=created_at.desc`, { headers: SUPA_HEADERS });
  return res.data.map(row => ({
    id:        row.id,
    nombre:    row.nombre,
    estado:    row.estado,
    urgencia:  row.urgencia,
    fecha:     row.fecha,
    monto:     row.monto,
    cuotas:    row.cuotas,
    cuotaList: row.cuota_list || [],
    createdAt: row.created_at
  }));
}

async function dbCreate(data) {
  const res = await axios.post(`${SUPABASE_URL}/rest/v1/tasks`, {
    nombre:    data.nombre,
    estado:    data.estado    || "Pendiente",
    urgencia:  data.urgencia  || "Media",
    fecha:     data.fecha     || "",
    monto:     data.monto     || 0,
    cuotas:    data.cuotas    || 1,
    cuota_list: data.cuotaList || []
  }, { headers: SUPA_HEADERS });
  const row = res.data[0];
  return { id:row.id, nombre:row.nombre, estado:row.estado, urgencia:row.urgencia, fecha:row.fecha, monto:row.monto, cuotas:row.cuotas, cuotaList:row.cuota_list||[], createdAt:row.created_at };
}

async function dbUpdate(id, data) {
  const body = {};
  if (data.nombre    !== undefined) body.nombre    = data.nombre;
  if (data.estado    !== undefined) body.estado    = data.estado;
  if (data.urgencia  !== undefined) body.urgencia  = data.urgencia;
  if (data.fecha     !== undefined) body.fecha     = data.fecha;
  if (data.monto     !== undefined) body.monto     = data.monto;
  if (data.cuotaList !== undefined) body.cuota_list = data.cuotaList;
  const res = await axios.patch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, body, { headers: SUPA_HEADERS });
  const row = res.data[0];
  return { id:row.id, nombre:row.nombre, estado:row.estado, urgencia:row.urgencia, fecha:row.fecha, monto:row.monto, cuotas:row.cuotas, cuotaList:row.cuota_list||[] };
}

async function dbDelete(id) {
  await axios.delete(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, { headers: SUPA_HEADERS });
}

// ── Auth ──────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── REST API ──────────────────────────────────────────────────
app.get("/tasks", auth, async (req, res) => {
  try {
    const tasks = await dbGetAll();
    res.json({ tasks, total: tasks.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/tasks", auth, async (req, res) => {
  try {
    const task = await dbCreate(req.body);
    res.json({ ok: true, task });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/tasks/:id", auth, async (req, res) => {
  try {
    const task = await dbUpdate(parseInt(req.params.id), req.body);
    res.json({ ok: true, task });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/tasks/:id", auth, async (req, res) => {
  try {
    await dbDelete(parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Telegram ──────────────────────────────────────────────────
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

async function executeTool(name, input) {
  if (name === "get_tasks") {
    let tasks = await dbGetAll();
    if (input.filtro) {
      const f = input.filtro;
      tasks = tasks.filter(t => t.estado===f || t.urgencia===f || t.nombre.toLowerCase().includes(f.toLowerCase()));
    }
    return { ok:true, data:tasks, total:tasks.length };
  }
  if (name === "create_task") {
    const numCuotas = input.cuotas || 1;
    const cuotaList = Array.from({ length:numCuotas }, (_,i) => ({ n:i+1, monto: input.monto ? input.monto/numCuotas : 0, pagada:false }));
    const task = await dbCreate({ ...input, cuotaList });
    return { ok:true, task, message:`Tarea #${task.id} "${task.nombre}" creada.` };
  }
  if (name === "update_task") {
    const task = await dbUpdate(input.id, input);
    return { ok:true, task, message:`Tarea #${input.id} actualizada.` };
  }
  if (name === "delete_task") {
    await dbDelete(input.id);
    return { ok:true, message:`Tarea #${input.id} eliminada.` };
  }
  if (name === "mark_cuota_pagada") {
    const tasks = await dbGetAll();
    const task  = tasks.find(t => t.id === input.id);
    if (!task) return { ok:false, message:`No encontré tarea #${input.id}` };
    if (input.cuota_numero) {
      const c = task.cuotaList.find(c => c.n === input.cuota_numero);
      if (c) c.pagada = input.pagada;
    } else {
      task.cuotaList.forEach(c => c.pagada = input.pagada);
    }
    await dbUpdate(input.id, { cuotaList: task.cuotaList });
    const pagadas = task.cuotaList.filter(c=>c.pagada).length;
    return { ok:true, message:`${pagadas}/${task.cuotaList.length} cuotas pagadas.` };
  }
  return { ok:false, message:"Tool desconocida" };
}

function cleanHistory(msgs, maxPairs=5) {
  const clean = [];
  for (const msg of msgs) {
    if (typeof msg.content==="string" && msg.content.trim()) clean.push(msg);
  }
  return clean.slice(-(maxPairs*2));
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

  for (let i=0; i<25; i++) {
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    }, {
      headers: { "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json" }
    });

    const { content, stop_reason } = response.data;
    messages.push({ role:"assistant", content });

    if (stop_reason === "end_turn") {
      const text = content.filter(b=>b.type==="text").map(b=>b.text).join("\n");
      histories[chatId] = cleanHistory([...safeHistory, { role:"user", content:userMessage }, { role:"assistant", content:text }]);
      return text || "✓ Listo.";
    }

    if (stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input);
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
  } catch(e) {
    console.error("Agent error:", e.response?.data || e.message);
    await sendMessage(chatId, "❌ Ocurrió un error. Intenta de nuevo.");
  }
});

app.get("/", (req, res) => res.send("Bot activo ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
