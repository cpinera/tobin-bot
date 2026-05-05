const express = require("express");
const { getGmailAuthUrl, saveGmailTokens, getEmailBatch, getEmailBody } = require("./gmail");
const { scanEmails, executeApproved, skipEmails, moveEmail, scheduleEmailScans } = require("./email-agent");
const { CALENDAR_TOOLS, executeCalendarTool, getOAuth2Client, setTokens } = require("./calendar");
const axios = require("axios");
const app = express();

app.use(express.json({ limit: "50mb" }));
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
const SUPA_HEADERS   = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation"
};
const histories = {};

// ── Supabase helpers ──
async function dbGetAll() {
  const res = await axios.get(`${SUPABASE_URL}/rest/v1/tasks?order=created_at.desc`, { headers: SUPA_HEADERS });
  return res.data.map(row => ({
    id: row.id, nombre: row.nombre, estado: row.estado, urgencia: row.urgencia,
    fecha: row.fecha, monto: row.monto, cuotas: row.cuotas,
    cuotaList: row.cuota_list || [], valor: row.valor || 5, esfuerzo: row.esfuerzo || 5,
    subtasks: row.subtasks || [], createdAt: row.created_at
  }));
}

async function dbCreate(data) {
  const res = await axios.post(`${SUPABASE_URL}/rest/v1/tasks`, {
    nombre: data.nombre, estado: data.estado || "Pendiente", urgencia: data.urgencia || "Media",
    fecha: data.fecha || "", monto: data.monto || 0, cuotas: data.cuotas || 1,
    cuota_list: data.cuotaList || [], valor: data.valor || 5, esfuerzo: data.esfuerzo || 5
  }, { headers: SUPA_HEADERS });
  const row = res.data[0];
  return {
    id: row.id, nombre: row.nombre, estado: row.estado, urgencia: row.urgencia,
    fecha: row.fecha, monto: row.monto, cuotas: row.cuotas,
    cuotaList: row.cuota_list || [], valor: row.valor || 5, esfuerzo: row.esfuerzo || 5,
    createdAt: row.created_at
  };
}

async function dbUpdate(id, data) {
  const body = {};
  if (data.nombre    !== undefined) body.nombre    = data.nombre;
  if (data.estado    !== undefined) body.estado    = data.estado;
  if (data.urgencia  !== undefined) body.urgencia  = data.urgencia;
  if (data.fecha     !== undefined) body.fecha     = data.fecha;
  if (data.monto     !== undefined) body.monto     = data.monto;
  if (data.cuotaList !== undefined) body.cuota_list = data.cuotaList;
  if (data.valor     !== undefined) body.valor     = data.valor;
  if (data.esfuerzo  !== undefined) body.esfuerzo  = data.esfuerzo;
  if (data.subtasks  !== undefined) body.subtasks  = data.subtasks;
  const res = await axios.patch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, body, { headers: SUPA_HEADERS });
  const row = res.data && res.data[0];
  if (!row) return { id };
  return {
    id: row.id, nombre: row.nombre, estado: row.estado, urgencia: row.urgencia,
    fecha: row.fecha, monto: row.monto, cuotas: row.cuotas,
    cuotaList: row.cuota_list || [], valor: row.valor || 5, esfuerzo: row.esfuerzo || 5,
    subtasks: row.subtasks || []
  };
}

async function dbDelete(id) {
  await axios.delete(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, { headers: SUPA_HEADERS });
}

function auth(req, res, next) {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Task endpoints ──
app.get("/tasks", auth, async (req, res) => {
  try { const tasks = await dbGetAll(); res.json({ tasks, total: tasks.length }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/tasks", auth, async (req, res) => {
  try { const task = await dbCreate(req.body); res.json({ ok: true, task }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/tasks/:id", auth, async (req, res) => {
  try { const task = await dbUpdate(parseInt(req.params.id), req.body); res.json({ ok: true, task }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/tasks/:id", auth, async (req, res) => {
  try { await dbDelete(parseInt(req.params.id)); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Telegram ──
async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId, text, parse_mode: "Markdown"
  }).catch(e => console.error("Send error:", e.response?.data));
}

const TOOLS = [
  ...CALENDAR_TOOLS,
  {
    name: "get_tasks",
    description: "Obtiene todas las tareas del to-do list.",
    input_schema: { type: "object", properties: { filtro: { type: "string" } } }
  },
  {
    name: "create_task",
    description: "Crea una nueva tarea. Llama UNA VEZ POR CADA tarea.",
    input_schema: {
      type: "object",
      properties: {
        nombre:   { type: "string" },
        estado:   { type: "string", enum: ["Pendiente","En progreso","Listo"] },
        urgencia: { type: "string", enum: ["Alta","Media","Baja"] },
        fecha:    { type: "string" },
        monto:    { type: "number" },
        cuotas:   { type: "integer" }
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
        id:       { type: "integer" },
        nombre:   { type: "string" },
        estado:   { type: "string", enum: ["Pendiente","En progreso","Listo"] },
        urgencia: { type: "string", enum: ["Alta","Media","Baja"] },
        fecha:    { type: "string" },
        monto:    { type: "number" }
      },
      required: ["id"]
    }
  },
  {
    name: "delete_task",
    description: "Elimina una tarea por ID.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
  },
  {
    name: "mark_cuota_pagada",
    description: "Marca cuotas como pagadas.",
    input_schema: {
      type: "object",
      properties: {
        id:            { type: "integer" },
        cuota_numero:  { type: "integer" },
        pagada:        { type: "boolean" }
      },
      required: ["id","pagada"]
    }
  }
];

async function executeTool(name, input) {
  if (["list_events","create_event","delete_event","list_calendars"].includes(name)) {
    try { return await executeCalendarTool(name, input); }
    catch(e) { return { ok: false, message: e.message }; }
  }
  if (name === "get_tasks") {
    let tasks = await dbGetAll();
    if (input.filtro) {
      const f = input.filtro;
      tasks = tasks.filter(t => t.estado === f || t.urgencia === f || t.nombre.toLowerCase().includes(f.toLowerCase()));
    }
    return { ok: true, data: tasks, total: tasks.length };
  }
  if (name === "create_task") {
    const numCuotas = input.cuotas || 1;
    const cuotaList = Array.from({ length: numCuotas }, (_, i) => ({
      n: i + 1, monto: input.monto ? input.monto / numCuotas : 0, pagada: false
    }));
    const task = await dbCreate({ ...input, cuotaList });
    return { ok: true, task, message: `Tarea #${task.id} "${task.nombre}" creada.` };
  }
  if (name === "update_task") {
    const task = await dbUpdate(input.id, input);
    return { ok: true, task, message: `Tarea #${input.id} actualizada.` };
  }
  if (name === "delete_task") {
    await dbDelete(input.id);
    return { ok: true, message: `Tarea #${input.id} eliminada.` };
  }
  if (name === "mark_cuota_pagada") {
    const tasks = await dbGetAll();
    const task = tasks.find(t => t.id === input.id);
    if (!task) return { ok: false, message: `No encontré tarea #${input.id}` };
    if (input.cuota_numero) {
      const c = task.cuotaList.find(c => c.n === input.cuota_numero);
      if (c) c.pagada = input.pagada;
    } else {
      task.cuotaList.forEach(c => c.pagada = input.pagada);
    }
    await dbUpdate(input.id, { cuotaList: task.cuotaList });
    const pagadas = task.cuotaList.filter(c => c.pagada).length;
    return { ok: true, message: `${pagadas}/${task.cuotaList.length} cuotas pagadas.` };
  }
  return { ok: false, message: "Tool desconocida" };
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
  const today = new Date().toLocaleDateString("es-CL", { weekday:"long", year:"numeric", month:"long", day:"numeric", timeZone:"America/Santiago" });
  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone:"America/Santiago" });
  const systemPrompt = `Eres un asistente de productividad personal que gestiona el to-do list del usuario. Eres conciso, amable y respondes en español. Hoy es ${today} (${todayISO}). Usa SIEMPRE esta fecha como referencia para calcular fechas relativas como "hoy", "mañana", "el viernes", etc. Para listar tareas usa este formato: • #ID EMOJI *Nombre* — URGENCIA Estados: ⏳ Pendiente | 🔄 En progreso | ✅ Listo Urgencia: 🔴 Alta | 🟡 Media | 🟢 Baja Cuando el usuario pida agregar MÚLTIPLES tareas, llama create_task individualmente por cada una. Para eventos de calendario, las fechas en ISO 8601 con timezone Chile: ${todayISO}T14:00:00-03:00 Confirma las acciones brevemente.`;
  const safeHistory = cleanHistory(histories[chatId]);
  let messages = [...safeHistory, { role: "user", content: userMessage }];
  for (let i = 0; i < 25; i++) {
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      tools: TOOLS,
      messages
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
      histories[chatId] = cleanHistory([...safeHistory, { role:"user", content:userMessage }, { role:"assistant", content:text }]);
      return text || "✓ Listo.";
    }
    if (stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
  return "No pude completar la acción, intenta de nuevo.";
}

// ── Gmail endpoints ──
app.get("/gmail/start", (req, res) => res.redirect(getGmailAuthUrl()));

app.get("/gmail/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { google } = require("googleapis");
    const oauth2 = new google.auth.OAuth2(
      process.env.GCAL_CLIENT_ID,
      process.env.GCAL_CLIENT_SECRET,
      "https://tobin-bot-production.up.railway.app/gmail/callback"
    );
    const { tokens } = await oauth2.getToken(code);
    await saveGmailTokens(tokens);
    res.send("<h2>✅ Gmail conectado</h2><p>Puedes cerrar esta ventana.</p>");
  } catch(e) {
    res.send("<h2>Error: " + e.message + "</h2>");
  }
});

app.get("/emails", auth, async (req, res) => {
  try { const emails = await getEmailBatch(req.query.status || "pending"); res.json({ emails }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/emails/scan", auth, async (req, res) => {
  try { const result = await scanEmails(req.body.hours || 13, sendTelegramMessage); res.json(result); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/emails/execute", auth, async (req, res) => {
  try {
    const { gmailIds } = req.body;
    const result = await executeApproved(gmailIds);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/emails/skip", auth, async (req, res) => {
  try { await skipEmails(req.body.gmailIds); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/emails/move", auth, async (req, res) => {
  try { await moveEmail(req.body.gmailId, req.body.classification); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/emails/scan-now", auth, async (req, res) => {
  try { const result = await scanEmails(48, sendTelegramMessage); res.json({ ok: true, ...result }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/emails/:gmailId/body", auth, async (req, res) => {
  try { const body = await getEmailBody(req.params.gmailId); res.json({ body }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/emails/:gmailId", auth, async (req, res) => {
  try { const { updateEmail } = require("./gmail"); await updateEmail(req.params.gmailId, req.body); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Google Calendar OAuth ──
app.get("/oauth/start", (req, res) => {
  const oauth2 = getOAuth2Client();
  const url = oauth2.generateAuthUrl({ access_type: "offline", scope: ["https://www.googleapis.com/auth/calendar"], prompt: "consent" });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(req.query.code);
    setTokens(tokens);
    res.send("<h2>Google Calendar conectado</h2><p>Puedes cerrar esta ventana.</p>");
  } catch(e) { res.send("<h2>Error: " + e.message + "</h2>"); }
});

// ── Expense agent (voice/photo) ──
const { processExpense } = require("./expense-agent");
const FormData = require("form-data");

async function transcribeVoice(fileBuffer, mimeType) {
  const form = new FormData();
  form.append("file", fileBuffer, { filename: "audio.ogg", contentType: mimeType || "audio/ogg" });
  form.append("model", "whisper-1");
  form.append("language", "es");
  const res = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
    headers: { ...form.getHeaders(), "Authorization": `Bearer ${process.env.OPENAI_KEY}` }
  });
  return res.data.text;
}

async function downloadTelegramFile(fileId) {
  const infoRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = infoRes.data.result.file_path;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const fileRes = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(fileRes.data);
}

function buildExpenseReply(result) {
  let msg = "✅ Gasto registrado en Airtable\n\n";
  msg += `📌 Item: ${result.item}\n`;
  msg += `📅 Fecha: ${result.fechaGasto}\n`;
  msg += `🗓 Mes: ${result.mes} ${result.anio}\n`;
  msg += `💰 Total: $${result.totalCLP.toLocaleString("es-CL")} CLP`;
  if (result.moneda && result.moneda !== "CLP") {
    const rate = result.conversionRate ? Math.round(result.conversionRate).toLocaleString("es-CL") : "?";
    msg += `\n (${result.moneda} ${result.totalOriginal.toLocaleString("es-CL")} x $${rate} = CLP)`;
  }
  msg += "\n📎 Respaldo: imagen subida";
  return msg;
}

// ── Webhook ──
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;

  if (msg.photo) {
    await sendMessage(chatId, "⏳ Procesando boleta...");
    try {
      const photo = msg.photo.at(-1);
      const buffer = await downloadTelegramFile(photo.file_id);
      const result = await processExpense(buffer, "image/jpeg", `boleta_${Date.now()}.jpg`, msg.date);
      await sendMessage(chatId, buildExpenseReply(result));
    } catch(e) { await sendMessage(chatId, `❌ Error procesando imagen: ${e.message}`); }
    return;
  }

  if (msg.document) {
    const doc = msg.document;
    const accepted = ["application/pdf","image/jpeg","image/png","image/jpg","image/webp"];
    if (!accepted.includes(doc.mime_type)) {
      await sendMessage(chatId, "⚠️ Solo acepto fotos o PDFs para registrar gastos.");
      return;
    }
    await sendMessage(chatId, "⏳ Procesando documento...");
    try {
      const buffer = await downloadTelegramFile(doc.file_id);
      const result = await processExpense(buffer, doc.mime_type, doc.file_name || `doc_${Date.now()}`, msg.date);
      await sendMessage(chatId, buildExpenseReply(result));
    } catch(e) { await sendMessage(chatId, `❌ Error procesando documento: ${e.message}`); }
    return;
  }

  if (msg.voice || msg.audio) {
    const audio = msg.voice || msg.audio;
    try {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const buffer = await downloadTelegramFile(audio.file_id);
      const transcript = await transcribeVoice(buffer, audio.mime_type || "audio/ogg");
      const reply = await runAgent(chatId, transcript);
      await sendMessage(chatId, `🎤 _"${transcript}"_\n\n${reply}`);
    } catch(e) { await sendMessage(chatId, `❌ No pude entender el audio: ${e.message}`); }
    return;
  }

  if (msg.text) {
    try {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const reply = await runAgent(chatId, msg.text);
      await sendMessage(chatId, reply);
    } catch(e) { await sendMessage(chatId, "❌ Ocurrió un error. Intenta de nuevo."); }
  }
});

// ── Cuentas ──
app.get("/cuentas", auth, async (req, res) => {
  try { const r = await axios.get(`${SUPABASE_URL}/rest/v1/cuentas?order=nombre`, { headers: SUPA_HEADERS }); res.json({ cuentas: r.data }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post("/cuentas", auth, async (req, res) => {
  try {
    const { nombre, mes, anio, monto, estado } = req.body;
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/cuentas`, { nombre, mes, anio, monto: monto||0, estado: estado||"Por pagar" }, { headers: SUPA_HEADERS });
    res.json({ cuenta: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch("/cuentas/:id", auth, async (req, res) => {
  try { const r = await axios.patch(`${SUPABASE_URL}/rest/v1/cuentas?id=eq.${req.params.id}`, req.body, { headers: SUPA_HEADERS }); res.json({ cuenta: r.data[0] }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete("/cuentas/:id", auth, async (req, res) => {
  try { await axios.delete(`${SUPABASE_URL}/rest/v1/cuentas?id=eq.${req.params.id}`, { headers: SUPA_HEADERS }); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Email digest ──
const RESEND_KEY = process.env.RESEND_KEY;
const EMAIL_TO   = process.env.EMAIL_TO;

async function sendDailyDigest() {
  try {
    const tasks = await dbGetAll();
    const pending = tasks.filter(t => t.estado !== "Listo");
    const top3 = [...pending].map(t => ({ ...t, score: (t.valor||5)/(t.esfuerzo||5) })).sort((a,b) => b.score - a.score).slice(0, 3);
    if (!top3.length) return;
    const today = new Date().toLocaleDateString("es-CL", { weekday:"long", year:"numeric", month:"long", day:"numeric", timeZone:"America/Santiago" });
    const todayCap = today.charAt(0).toUpperCase() + today.slice(1);
    const dateShort = new Date().toLocaleDateString("es-CL", { day:"2-digit", month:"2-digit", year:"numeric", timeZone:"America/Santiago" });
    const rows = top3.map((t, i) => {
      const score = Math.round(t.score * 10) / 10;
      const estado = t.estado === "En progreso" ? "🔄 En progreso" : "⏳ Pendiente";
      const numColor = i===0 ? "#1a73e8" : i===1 ? "#34a853" : "#f29900";
      return `<div style="padding:20px 24px;border-bottom:1px solid #e8eaed"><div style="display:flex;align-items:flex-start;gap:14px"><div style="min-width:28px;height:28px;border-radius:50%;background:${numColor};color:#fff;font-size:13px;font-weight:700;text-align:center;line-height:28px;flex-shrink:0">${i+1}</div><div style="flex:1"><p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#202124">${t.nombre}</p><div style="display:flex;gap:8px;flex-wrap:wrap"><span style="font-size:12px;color:#5f6368">${estado}</span><span style="font-size:12px;color:#5f6368">Score ${score}</span></div></div></div></div>`;
    }).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f8f9fa;font-family:Roboto,Arial,sans-serif"><div style="max-width:600px;margin:0 auto;padding:32px 16px"><h1 style="font-size:26px;font-weight:700;color:#202124">${todayCap}</h1><div style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(60,64,67,.12);overflow:hidden;margin:20px 0">${rows}</div><div style="text-align:center;margin-bottom:28px"><a href="https://tobin-todo-web.vercel.app" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:11px 32px;border-radius:8px;font-size:14px;font-weight:600">Ver todas las tareas →</a></div></div></body></html>`;
    await axios.post("https://api.resend.com/emails", {
      from: "To-Do Tobin <noreply@tantauco.vc>",
      to: EMAIL_TO,
      subject: `To-Do ${dateShort}`,
      html
    }, { headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" } });
    console.log("Email diario enviado a", EMAIL_TO);
  } catch(e) { console.error("Error enviando email:", e.response?.data || e.message); }
}

function scheduleDailyEmail() {
  function msUntilNext11UTC() {
    const now = new Date(), next = new Date();
    next.setUTCHours(11, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  const ms = msUntilNext11UTC();
  console.log(`Email programado en ${Math.round(ms/1000/60)} minutos (11:00 UTC = 07:00 Chile)`);
  setTimeout(() => { sendDailyDigest(); setInterval(sendDailyDigest, 24*60*60*1000); }, ms);
}

scheduleDailyEmail();
scheduleEmailScans(sendTelegramMessage);

app.get("/send-digest", (req, res) => {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  sendDailyDigest();
  res.json({ ok: true, message: "Enviando digest..." });
});

app.get("/", (req, res) => res.send("Bot activo ✓"));

// ── Calendar reminders & morning briefing ──
const CHAT_ID = process.env.CHAT_ID || "7783704824";
async function sendTelegramMessage(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text, parse_mode: "Markdown" });
}

async function sendMorningBriefing() {
  try {
    const tasks = await dbGetAll();
    const pending = tasks.filter(t => t.estado !== "Listo");
    const top3 = [...pending].map(t => ({ ...t, score: (t.valor||5)/(t.esfuerzo||5) })).sort((a,b) => b.score-a.score).slice(0,3);
    const dateStr = new Date().toLocaleDateString("es-CL", { weekday:"long", day:"numeric", month:"long", timeZone:"America/Santiago" });
    const dateCap = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    let lines = ["*Buenos dias!*", "_" + dateCap + "_", ""];
    if (top3.length) {
      lines.push("*Top 3 tareas de hoy:*");
      ["1.","2.","3."].forEach((m,i) => {
        if (top3[i]) lines.push(m + " " + top3[i].nombre + " (score: " + Math.round(top3[i].score*10)/10 + ")");
      });
    } else {
      lines.push("No tienes tareas pendientes!");
    }
    try {
      const calMod = require("./calendar");
      const result = await calMod.executeCalendarTool("list_events", { days: 1 });
      if (result.events && result.events.length) {
        lines.push(""); lines.push("*Eventos de hoy:*");
        result.events.forEach(e => {
          const time = e.start ? new Date(e.start).toLocaleTimeString("es-CL", { hour:"2-digit", minute:"2-digit", timeZone:"America/Santiago" }) : "";
          lines.push("- " + time + " " + e.summary);
        });
      }
    } catch(e) {}
    await sendTelegramMessage(lines.join("\n"));
    console.log("Morning briefing enviado");
  } catch(e) { console.error("Error morning briefing:", e.message); }
}

const notifiedEvents = new Set();
async function checkCalendarReminders() {
  try {
    const calMod = require("./calendar");
    const result = await calMod.executeCalendarTool("list_events", { days: 1 });
    if (!result.events || !result.events.length) return;
    const now = new Date();
    for (const event of result.events) {
      if (!event.start) continue;
      const start = new Date(event.start);
      const diffMin = (start - now) / 1000 / 60;
      if (diffMin > 0 && diffMin <= 30 && !notifiedEvents.has(event.id)) {
        notifiedEvents.add(event.id);
        const timeStr = start.toLocaleTimeString("es-CL", { hour:"2-digit", minute:"2-digit", timeZone:"America/Santiago" });
        await sendTelegramMessage(`Recordatorio: *${event.summary}* empieza en ${Math.round(diffMin)} minutos (${timeStr})`);
      }
    }
    if (notifiedEvents.size > 200) notifiedEvents.clear();
  } catch(e) {}
}

function scheduleMorningBriefing() {
  function msUntilNext11UTC() {
    const now = new Date(), next = new Date();
    next.setUTCHours(11, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  const ms = msUntilNext11UTC();
  console.log(`Morning briefing programado en ${Math.round(ms/1000/60)} min`);
  setTimeout(() => { sendMorningBriefing(); setInterval(sendMorningBriefing, 24*60*60*1000); }, ms);
}

setInterval(checkCalendarReminders, 5*60*1000);
scheduleMorningBriefing();

app.get("/send-briefing", (req, res) => {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  sendMorningBriefing();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// FINANZAS v2 — análisis de cartolas con contexto histórico
// ══════════════════════════════════════════════════════════════════════

const MESES_NOMBRE = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// Construye el system prompt para el análisis de cartolas (TC y cta cte).
function buildSystemPrompt({ cuenta_tipo, cuenta_id, cuenta_nombre, periodo, gfCatalog, cuentasCorrientes, tarjetasCredito, suscripcionesConocidas, contexto }) {
  const ctx = contexto || {};
  const reglas = ctx.reglas || { tolerancia_monto_pct: 0.5, tolerancia_monto_abs: 100, tolerancia_fecha_dias: 5 };
  const ciclo = ctx.cicloTC || { desde_dia: 21, hasta_dia: 20 };
  const mesActual = ctx.mesActual;
  const anioActual = ctx.anioActual;

  const gfRef = (gfCatalog || []).map((r, i) => {
    if (Array.isArray(r)) return `${i+1}: ${r[1]} (${r[0]})`;
    return `${r.id}: ${r.nombre || r.descripcion} (${r.categoria})`;
  }).join("\n  ");

  const ccRef = (cuentasCorrientes || []).map(c => `${c.id}: ${c.nombre} (${c.moneda})`).join("\n  ");
  const tcRef = (tarjetasCredito  || []).map(c => `${c.id}: ${c.nombre} (${c.moneda})`).join("\n  ");

  const subsRef = (suscripcionesConocidas || []).slice(0, 30).map(s => {
    const meses = (s.monthsSeen || []).join(",") || "—";
    return `${s.n}: $${s.clp || 0} CLP (vista en ${meses})`;
  }).join("\n  ");

  const histMovs = (ctx.movimientosUltimosMeses || []).slice(0, 80).map(m => {
    const flags = [m.es_ingreso && "ing", m.es_suscripcion && "sub", m.es_transferencia_interna && "int", m.es_gasto_fijo && `gf=${m.gf_item_id}`].filter(Boolean).join(",");
    return `${m.fecha} | ${m.cuenta_id} | $${m.monto} | "${(m.descripcion || "").slice(0, 50)}" | ${m.categoria || "?"} ${flags ? "["+flags+"]" : ""}`;
  }).join("\n  ");

  const movsActual = (ctx.movimientosMesActual || []).slice(0, 60).map(m => {
    const flags = [m.es_ingreso && "ing", m.es_transferencia_interna && "int", m.es_gasto_fijo && "gf"].filter(Boolean).join(",");
    return `${m.fecha} | ${m.cuenta_id} | $${m.monto} | "${(m.descripcion || "").slice(0, 50)}" ${flags ? "["+flags+"]" : ""}`;
  }).join("\n  ");

  const ingResgRef = (ctx.ingresosRegistrados || []).slice(0, 30).map(i =>
    `${i.tipo}: $${i.monto} ${i.moneda || "CLP"} (${i.mes}/${i.anio})${i.descripcion ? " — "+i.descripcion : ""}`
  ).join("\n  ");

  const tipoCartola = cuenta_tipo === "cuenta_corriente" ? "una CUENTA CORRIENTE" : "una TARJETA DE CRÉDITO";

  return `Eres un asistente financiero personal analizando ${tipoCartola} de Cristóbal Piñera.

CONTEXTO BÁSICO
═══════════════════════════════════════════════════════════════════
Cuenta a analizar: ${cuenta_nombre} (id: ${cuenta_id}, tipo: ${cuenta_tipo})
Período declarado por el usuario: ${periodo}
Mes/año declarado: ${mesActual}/${anioActual}

CATÁLOGO DE GASTOS FIJOS (id : nombre (categoria))
═══════════════════════════════════════════════════════════════════
  ${gfRef}

CUENTAS DEL USUARIO
═══════════════════════════════════════════════════════════════════
Tarjetas de crédito:
  ${tcRef}

Cuentas corrientes:
  ${ccRef}

SUSCRIPCIONES CONOCIDAS
═══════════════════════════════════════════════════════════════════
  ${subsRef || "(ninguna registrada todavía)"}

MOVIMIENTOS HISTÓRICOS (últimos 3 meses) — para detectar patrones recurrentes
═══════════════════════════════════════════════════════════════════
  ${histMovs || "(sin histórico)"}

MOVIMIENTOS YA EXTRAÍDOS DE OTRAS CARTOLAS DEL MISMO MES (no los repitas)
═══════════════════════════════════════════════════════════════════
  ${movsActual || "(esta es la primera cartola del mes)"}

INGRESOS YA REGISTRADOS POR EL USUARIO
═══════════════════════════════════════════════════════════════════
  ${ingResgRef || "(sin ingresos registrados aún)"}

CICLO TC: las TC chilenas cierran del día ${ciclo.desde_dia} al día ${ciclo.hasta_dia} del mes siguiente.
TOLERANCIAS: ±${reglas.tolerancia_monto_pct}% o ±$${reglas.tolerancia_monto_abs} se considera "mismo monto".

═══════════════════════════════════════════════════════════════════
REGLAS DE EXTRACCIÓN
═══════════════════════════════════════════════════════════════════

REGLA 1 — FILTRO DE MES (CRÍTICA, NO ROMPER)
${cuenta_tipo === "cuenta_corriente"
  ? `  - Las cartolas de cuenta corriente Security pueden incluir hasta 5 meses
    de movimientos históricos. EXTRAE SOLO los movimientos cuya fecha esté
    en el mes ${mesActual}/${anioActual} (1 al último día).
  - Ignora todo lo demás aunque aparezca en el PDF.`
  : `  - Las cartolas TC chilenas cierran ~día 20-22. Una "cartola de ${MESES_NOMBRE[mesActual-1]}"
    típica trae movimientos del día ${ciclo.desde_dia} del mes anterior al día ${ciclo.hasta_dia}
    de ${MESES_NOMBRE[mesActual-1]}. Extrae todos esos movimientos y asígnalos al mes ${mesActual}.`}

REGLA 2 — CATEGORÍAS (usa EXACTAMENTE estos nombres)
  Restaurantes, Alimentación Familia, Salud, Ropa/Shopping, Hogar, Viajes,
  Suscripciones, Software, Deporte, Transporte, Entretenimiento, Educación,
  Servicios, Casa Santiago, Casa Cachagua, Créditos, Sueldos, Seguros,
  Trimestrales, Ingreso, Transferencia interna, Otros.

REGLA 3 — DETECTAR INGRESOS (es_ingreso:true)
  Patrones a marcar como ingreso:
  - "ABONO DE REMUNERACIONES" en cta cte Security cc2 → tipo_ingreso:"Sueldo Tantauco" (confirmado por usuario).
  - "TRANSFERENCIA DESDE Chile DE INVERSIONES ODISEA" → tipo_ingreso:"Sueldo Odisea".
  - "TRANSF. ASESORIAS" con RUT 77.479.934-6 → tipo_ingreso:"Sueldo Tantauco" (probable, confirmar si monto es atípico).
  - "TRANSF DE JUAN SEBASTIAN PINE" → tipo_ingreso:"Otro retiro / aporte familiar".
  - "TRANSFERENCIA BTG PACTUAL" → tipo_ingreso:"Rescate inversión" (NO recurrente).
  - "PAGO PROVEEDOR COLMENA GOL" / "PAGO PROVEEDOR CNS SEGUROS" → tipo_ingreso:"Devolución" (NO recurrente).
  - Cualquier abono >$500.000 que no caiga en patrones conocidos → marca es_ingreso:true PERO agrega a "dudosos" con razon:"ingreso_no_esperado".

REGLA 4 — DETECTAR TRANSFERENCIAS INTERNAS (es_transferencia_interna:true, NO contar como gasto NI ingreso)

⚠️ CRITERIO CONTABLE: el balance del mes (ingresos - gastos) debe acercarse a 0
si la persona no ahorra activamente. Cualquier movimiento entre cuentas/sociedades
del usuario (Cristóbal Piñera Morel + esposa Sofía + sociedad Oahu) DEBE marcarse
como interna, o duplicaremos el conteo.

UNIVERSO DE CUENTAS DEL USUARIO (todas las transferencias entre estas son INTERNAS):
  - Cta cte Santander Cristóbal: 0-000-62-41496-0 (cc1)
  - Cta cte Security Cristóbal: 919293583 (cc2)
  - Cta cte Security Sofía: 919614625 (cc3)
  - Cta cte Security Oahu (sociedad propia): 928697494 (cc5)
  - 8 tarjetas de crédito (tc1-tc8)

A. Pagos de TC desde cta cte (SIEMPRE es_transferencia_interna:true):
  Patrones a detectar (cualquier descripción que contenga estas palabras):
  - "Traspaso Internet a T. Crédito" (Santander cc1)
  - "Traspaso ... Tarjeta" / "Traspaso ... T.Credito" / "Traspaso ... TC"
  - "PAGO TARJETA CREDITO POR INTERNET" (Security cc2)
  - "PAGO TARJETA" / "PAGO T. CREDITO" / "PAGO T.CREDITO" / "PAGO TC"
  - "ABONO TARJETA"
  → Match el monto con MONTO TOTAL FACTURADO de las TC del mes para sugerir cuenta_destino_sugerida.

B. Compra de USD para pagar TC USD (SIEMPRE es_transferencia_interna:true):
  - "COMPRA USD POR INTERNET PARA PAGO T.CREDITO"
  - "Egreso por Compra de Divisas"
  - "COMPRA DE DIVISAS"
  - "INGRESO POR VENTA DE DIVISAS" (la contraparte)
  Suelen venir en pares pequeños (uno por monto, otro por costo); ambos son interna.

C. Transferencias entre cuentas propias del usuario (SIEMPRE es_transferencia_interna:true):
  Todas las transferencias donde el TITULAR de origen o destino sea Cristóbal Piñera, Sofía Marín o sociedad Oahu.
  - "TRANSFERENCIA DESDE Santander DE CRISTOBAL PINERA MOREL"
  - "TRANSFERENCIA DESDE Security DE CRISTOBAL PI?ERA MOREL" (la "?" es ñ mal codeada)
  - "TRANSFERENCIA DESDE Chile DE CRISTOBAL PINERA"
  - "TRANSFERENCIA A Security PARA Oahu" → cuenta_destino_sugerida:"cc5"
  - "TRANSFERENCIA A Security PARA Sofia Marin" → cuenta_destino_sugerida:"cc3"
  - "TRANSFERENCIA A Santander PARA cristobal" → cuenta_destino_sugerida:"cc1"
  - "TRANSF A CUENTA SECURITY" → cuenta_destino_sugerida:"cc2"
  - "TRANSF A SOFIA MARIN" → cuenta_destino_sugerida:"cc3"
  - "TRANSF A OAHU" / "TRANSFERENCIA A OAHU" → cuenta_destino_sugerida:"cc5"
  - "TRANSF A SANTANDER" → cuenta_destino_sugerida:"cc1"
  - "TRANSFERENCIA INTERNA"

D. Casos que NO son transferencia interna (son gastos o ingresos reales):
  - "TRANSF A GABRIEL" / "TRANSF A VIVIAN JESSY" / "TRANSF A RICARDO" / "TRANSF A PALMENIA"
    → SON GASTOS (sueldos a empleados externos), NO son internas.
  - "TRANSF A SUR RALISTA" / "TRANSF A RIEGO" / "TRANSF A JARDINERO" → proveedores externos, son GASTOS.
  - "TRANSF DE JUAN SEBASTIAN PINE" → ingreso externo de hermano, NO es interna.
  - "TRANSFERENCIA BTG PACTUAL" → ingreso externo (rescate de inversión externa), NO es interna.
  - "TRANSF DE INVERSIONES ODISEA" → si Odisea es empresa externa pagando sueldo, es INGRESO.
  - "TRANSF DE ASESORIAS" / "TRANSF ASESORIAS" → ingreso externo (sueldo Tantauco probablemente).

REGLA 5 — RUIDO BANCARIO (categoria:"Transferencia interna", monto correcto, NO contar como gasto)
  Estos siempre vienen en pares y se cancelan entre sí:
  - "TRANSFERENCIA DESDE LÍNEA DE SOBREGIRO"
  - "PAGO DE LINEA DE CREDITO"
  - "PAGO AUTOMATICO LINEA SOBREGIRO"
  Marca todos como es_transferencia_interna:true.

  Estos SÍ son gastos pequeños (Servicios):
  - "INTERES POR USO LINEA DE SOBREGIRO" (~$25k)
  - "IMPTO CARGO USO LINEA DE SOBREGIRO" (~$1k)
  - "COM.MANTENCION PLAN" (~$23k)

REGLA 6 — GASTOS FIJOS (es_gasto_fijo:true con gf_item_id correcto)
  Match SOLO contra IDs reales del catálogo de arriba. NO inventar IDs.

  Patrones confirmados:
  - "COLEGIO VILLA MARIA" o "VMA" → gf_item_id:17 (VMA).
  - "Cordillera" o "COL CORDILLERA" → gf_item_id:18 (puede aparecer hasta 3 veces, una por hijo).
  - "TRANSF A GABRIEL" (puede partido en varios pagos en el mismo mes) → gf_item_id:14, sumar todos.
  - "TRANSF A VIVIAN JESSY" → gf_item_id:15.
  - "TRANSF A RICARDO" → gf_item_id:16.
  - "PAGO AUTOMATICO DE CREDITO HIPOTECARIO" en Oahu cc5 (~$3.250.000) → gf_item_id:10 (Oficina).
  - "PAGO WEB HIPOTECARIO" o "PRESTAMOS CUOTA FIJA" en Security cc2 con monto ~$4.500.000 → gf_item_id:11 (Terreno).
  - Cargos de hipotecario Santander 1 (~$397k) → gf_item_id:12.
  - Cargos de hipotecario Santander 2 (~$411k) → gf_item_id:13.
  - "PAT CONSORCIO GEN ALE" en TC → categoria:"Seguros", es_gasto_fijo:false (ya está incluido en el cargo total de la TC).

REGLA 7 — SUSCRIPCIONES (es_suscripcion:true)
  - Si el cargo coincide con un nombre de "SUSCRIPCIONES CONOCIDAS" arriba con monto ±10%,
    marca silenciosamente es_suscripcion:true.
  - Si el monto cambió >10% vs lo conocido, marca dudoso con razon:"cambio_monto" y referencia:{n,clp}.
  - Si NO está en el catálogo pero parece recurrente (Apple, Netflix, Spotify, OpenAI, Claude,
    ChatGPT, Google, Microsoft, X Corp, Patreon, Audible, iCloud, Zwift, Strava, TrainingPeaks,
    Booking, etc.), Y existe un cargo similar en el histórico de los últimos 3 meses,
    marca es_suscripcion:true silenciosamente.
  - Si parece nueva (no está en catálogo NI en histórico), marca es_suscripcion:true PERO
    agrega a dudosos con razon:"suscripcion_nueva".

REGLA 8 — RECONCILIACIÓN CRUZADA (lo nuevo vs lo registrado)
  Para cada movimiento que parece coincidir con uno del histórico o del mes actual:
  - Match exacto (diff <$10 ó <0.005%): silencioso.
  - Match aproximado (diff <$100 ó <0.5%): silencioso, anota en descripción "(aprox)".
  - Discrepancia (diff <$1000 ó <2%): marca dudoso con razon:"discrepancia_monto" y
    referencia:{monto, descripcion, fuente}.
  - Match imposible (diff mayor): trata como movimiento separado.

  EJEMPLO CRÍTICO:
  Usuario tiene ingreso registrado: Sueldo Tantauco $10.000.000 (de marzo).
  Cartola muestra: ABONO DE REMUNERACIONES $10.202.531.
  → Marca el movimiento es_ingreso:true tipo_ingreso:"Sueldo Tantauco" PERO en dudosos:
    {"idx":N, "razon":"discrepancia_monto", "referencia":{"monto":10000000,"descripcion":"Sueldo Tantauco","fuente":"ingreso registrado mes anterior"}}

REGLA 9 — DUDOSOS QUE DEBES EMITIR (cada uno con razon)
  - "discrepancia_monto" → match con monto cercano pero no exacto.
  - "pago_tc_sin_match" → pago a TC propia sin contraparte clara en otra cuenta.
  - "fecha_ambigua" → fecha cae entre día 18 y 23 (zona de cruce ciclo TC).
  - "suscripcion_nueva" → cargo recurrente no conocido.
  - "cambio_monto" → suscripción conocida con monto diferente.
  - "gasto_extraordinario" → monto >$500.000 CLP no clasificado claramente
    (incluye el pago al SII si aparece, monto típico >$10M).
  - "ingreso_no_esperado" → depósito que no matchea con tipos conocidos.
  - "posible_interna" → movimiento que parece transferencia interna pero no estás 100% seguro.

REGLA 10 — VALIDACIÓN DE CUADRE (CRÍTICA, hacer ANTES de responder)

Antes de devolver el JSON final, revisa CADA movimiento contra esta checklist:

  ¿Descripción menciona "Traspaso", "PAGO TARJETA", "PAGO T.CREDITO", "PAGO TC"?
    → DEBE tener es_transferencia_interna:true. Si no lo tiene, corrígelo.

  ¿Descripción menciona "Compra de Divisas", "COMPRA USD", "VENTA USD"?
    → DEBE tener es_transferencia_interna:true.

  ¿Descripción menciona transferencia a/desde "CRISTOBAL PINERA"/"PIÑERA"/"PI?ERA",
   o a/desde "SOFIA MARIN", o a/desde "Oahu"?
    → DEBE tener es_transferencia_interna:true (movimiento entre cuentas propias).

  ¿Descripción dice "LÍNEA DE SOBREGIRO", "PAGO DE LINEA DE CREDITO",
   "PAGO AUTOMATICO LINEA SOBREGIRO"?
    → DEBE tener es_transferencia_interna:true (ruido contable bancario).

Si tienes dudas sobre si algo es interna o no, MARCA como transferencia_interna y
agrégalo a "dudosos" con razon:"posible_interna" — es preferible marcar de más
y que el usuario confirme, que dejar pasar duplicados que rompen el cuadre.

PRINCIPIO CONTABLE: El balance del mes (ingresos reales - gastos reales) debe
acercarse a 0 si la persona no ahorra activamente. Si después de tu análisis
el balance del mes parece muy positivo o muy negativo, probablemente faltó
marcar alguna transferencia interna.

═══════════════════════════════════════════════════════════════════
FORMATO DE RESPUESTA (SOLO JSON, NADA MÁS)
═══════════════════════════════════════════════════════════════════
{
  "mes_detectado": ${mesActual},
  "anio_detectado": ${anioActual},
  "periodo_detectado": "string como aparece en cartola",
  "tarjeta_detectada": "string",
  "total": <suma de gastos no-internos>,
  "resumen": "1-2 frases con hallazgos clave: suscripciones nuevas, cambios vs mes anterior, gastos extraordinarios",
  "movimientos": [
    {
      "fecha": "YYYY-MM-DD",
      "descripcion": "string",
      "monto": number,
      "moneda": "CLP" | "USD",
      "categoria": "string del catálogo de Regla 2",
      "es_gasto_fijo": boolean,
      "gf_item_id": number | null,
      "es_ingreso": boolean,
      "tipo_ingreso": "string" | null,
      "es_suscripcion": boolean,
      "es_transferencia_interna": boolean,
      "cuenta_destino_sugerida": "tcN | ccN | null",
      "revisado": true
    }
  ],
  "dudosos": [
    {"idx": number, "razon": "string", "razon_extra": "string opcional", "referencia": {} }
  ]
}`;
}

// Función compartida que llama a Claude para analizar una cartola.
async function analizarCartola(req, res) {
  try {
    const {
      base64, mimeType, cuenta_id, cuenta_nombre, cuenta_tipo, periodo,
      gfCatalog, cuentasCorrientes, tarjetasCredito, suscripcionesConocidas, contexto,
      tarjeta // compatibilidad con frontend viejo
    } = req.body;

    if (!base64 || !mimeType) return res.status(400).json({ error: "Falta archivo" });

    const tipoNorm = cuenta_tipo || "tc";
    const idNorm = cuenta_id || "tc1";
    const nombreNorm = cuenta_nombre || tarjeta || "Cuenta";

    const isPDF = mimeType === "application/pdf";
    const contentBlock = isPDF
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image",    source: { type: "base64", media_type: mimeType, data: base64 } };

    const sysPrompt = buildSystemPrompt({
      cuenta_tipo: tipoNorm, cuenta_id: idNorm, cuenta_nombre: nombreNorm, periodo,
      gfCatalog, cuentasCorrientes, tarjetasCredito, suscripcionesConocidas, contexto
    });

    const userText = tipoNorm === "cuenta_corriente"
      ? `Analiza esta CARTOLA DE CUENTA CORRIENTE de ${nombreNorm}, período declarado ${periodo}. Recuerda Regla 1: extrae SOLO movimientos del mes ${contexto?.mesActual}/${contexto?.anioActual}.`
      : `Analiza esta CARTOLA DE TARJETA DE CRÉDITO de ${nombreNorm}, período declarado ${periodo}. Aplica el ciclo de cierre TC.`;

    const anthropicResp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 16000,
        system: sysPrompt,
        messages: [{
          role: "user",
          content: [ contentBlock, { type: "text", text: userText } ]
        }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "pdfs-2024-09-25",
          "content-type": "application/json"
        },
        timeout: 240000
      }
    );

    const raw = (anthropicResp.data.content || []).map(b => b.text || "").join("");
    const jm = raw.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error("Claude no devolvió JSON. Inicio: " + raw.slice(0, 200));

    let result;
    try {
      result = JSON.parse(jm[0]);
    } catch(parseErr) {
      console.error("JSON truncado, intentando recuperar...");
      const movMatch = jm[0].match(/"movimientos"\s*:\s*(\[[\s\S]*)/);
      if (movMatch) {
        let partial = movMatch[1];
        const opens  = (partial.match(/\{/g) || []).length;
        const closes = (partial.match(/\}/g) || []).length;
        for (let i = 0; i < opens - closes; i++) partial += "}";
        if (!partial.trim().endsWith("]")) partial += "]";
        try {
          result = { movimientos: JSON.parse(partial), dudosos: [], total: 0, resumen: "Análisis parcial (JSON truncado)", mes_detectado: contexto?.mesActual, anio_detectado: contexto?.anioActual };
        } catch(e2) {
          throw new Error("JSON inválido: " + parseErr.message);
        }
      } else {
        throw new Error("JSON truncado sin movimientos recuperables");
      }
    }

    res.json({ ok: true, ...result });
  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error("Error analizando cartola:", detail);
    res.status(500).json({ error: e.message, detail: e.response?.data || null });
  }
}

app.post("/analizar-tc", auth, analizarCartola);
app.post("/analizar-cuenta-corriente", auth, analizarCartola);

// ── Finanzas: Gastos fijos (catálogo y registros) ──
app.get("/gf/items", auth, async (req, res) => {
  try {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/gf_items?order=categoria,orden`, { headers: SUPA_HEADERS });
    res.json({ items: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/gf/items", auth, async (req, res) => {
  try {
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/gf_items`, req.body, { headers: SUPA_HEADERS });
    res.json({ item: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/gf/items/:id", auth, async (req, res) => {
  try {
    const r = await axios.patch(`${SUPABASE_URL}/rest/v1/gf_items?id=eq.${req.params.id}`, req.body, { headers: SUPA_HEADERS });
    res.json({ ok: true, item: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/gf/registros", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/gf_registros?mes=eq.${mes}&anio=eq.${anio}`, { headers: SUPA_HEADERS });
    res.json({ registros: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/gf/registros/:itemId/:mes/:anio", auth, async (req, res) => {
  try {
    const { itemId, mes, anio } = req.params;
    const existing = await axios.get(`${SUPABASE_URL}/rest/v1/gf_registros?item_id=eq.${itemId}&mes=eq.${mes}&anio=eq.${anio}`, { headers: SUPA_HEADERS });
    let r;
    if (existing.data && existing.data.length > 0) {
      r = await axios.patch(`${SUPABASE_URL}/rest/v1/gf_registros?item_id=eq.${itemId}&mes=eq.${mes}&anio=eq.${anio}`, req.body, { headers: SUPA_HEADERS });
    } else {
      r = await axios.post(`${SUPABASE_URL}/rest/v1/gf_registros`, { item_id: parseInt(itemId), mes: parseInt(mes), anio: parseInt(anio), ...req.body }, { headers: SUPA_HEADERS });
    }
    res.json({ ok: true, registro: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/gf/generar", auth, async (req, res) => {
  try {
    const { mes, anio } = req.body;
    const existing = await axios.get(`${SUPABASE_URL}/rest/v1/gf_registros?mes=eq.${mes}&anio=eq.${anio}`, { headers: SUPA_HEADERS });
    const existingIds = (existing.data || []).map(r => r.item_id);
    const items = await axios.get(`${SUPABASE_URL}/rest/v1/gf_items?activo=eq.true`, { headers: SUPA_HEADERS });
    const toCreate = (items.data || []).filter(item => !existingIds.includes(item.id)).map(item => ({ item_id: item.id, mes: parseInt(mes), anio: parseInt(anio), monto: 0, estado: "pendiente", nota: "" }));
    if (toCreate.length > 0) {
      await axios.post(`${SUPABASE_URL}/rest/v1/gf_registros`, toCreate, { headers: SUPA_HEADERS });
    }
    res.json({ ok: true, creados: toCreate.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Finanzas: Ingresos ──
app.get("/ingresos", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/ingresos?mes=eq.${mes}&anio=eq.${anio}&order=created_at.desc`, { headers: SUPA_HEADERS });
    res.json({ ingresos: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /ingresos con upsert por fuente_mov_id (idempotencia)
app.post("/ingresos", auth, async (req, res) => {
  try {
    const body = req.body;
    if (body.fuente_mov_id) {
      const existing = await axios.get(
        `${SUPABASE_URL}/rest/v1/ingresos?fuente_mov_id=eq.${body.fuente_mov_id}`,
        { headers: SUPA_HEADERS }
      );
      if (existing.data && existing.data.length > 0) {
        const r = await axios.patch(
          `${SUPABASE_URL}/rest/v1/ingresos?fuente_mov_id=eq.${body.fuente_mov_id}`,
          body,
          { headers: SUPA_HEADERS }
        );
        return res.json({ ingreso: r.data[0], upserted: true });
      }
    }
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/ingresos`, body, { headers: SUPA_HEADERS });
    res.json({ ingreso: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/ingresos/:id", auth, async (req, res) => {
  try { await axios.delete(`${SUPABASE_URL}/rest/v1/ingresos?id=eq.${req.params.id}`, { headers: SUPA_HEADERS }); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Finanzas: Movimientos TC y CC ──
app.get("/movimientos_tc", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/movimientos_tc?mes=eq.${mes}&anio=eq.${anio}&order=monto.desc`, { headers: SUPA_HEADERS });
    res.json({ movimientos: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /movimientos_tc con upsert por (cuenta_id, fecha, monto, descripcion, mes, anio) (idempotencia)
app.post("/movimientos_tc", auth, async (req, res) => {
  try {
    const body = req.body;
    if (body.cuenta_id && body.fecha && body.monto != null && body.descripcion) {
      const existing = await axios.get(
        `${SUPABASE_URL}/rest/v1/movimientos_tc` +
        `?cuenta_id=eq.${encodeURIComponent(body.cuenta_id)}` +
        `&fecha=eq.${body.fecha}` +
        `&monto=eq.${body.monto}` +
        `&descripcion=eq.${encodeURIComponent(body.descripcion)}` +
        `&mes=eq.${body.mes}&anio=eq.${body.anio}`,
        { headers: SUPA_HEADERS }
      );
      if (existing.data && existing.data.length > 0) {
        const existingId = existing.data[0].id;
        const r = await axios.patch(
          `${SUPABASE_URL}/rest/v1/movimientos_tc?id=eq.${existingId}`,
          body,
          { headers: SUPA_HEADERS }
        );
        return res.json({ movimiento: r.data[0], upserted: true });
      }
    }
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/movimientos_tc`, body, { headers: SUPA_HEADERS });
    res.json({ movimiento: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message, detail: e.response?.data || null }); }
});

app.patch("/movimientos_tc/:id", auth, async (req, res) => {
  try {
    const r = await axios.patch(`${SUPABASE_URL}/rest/v1/movimientos_tc?id=eq.${req.params.id}`, req.body, { headers: SUPA_HEADERS });
    res.json({ ok: true, movimiento: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/movimientos_tc/:id", auth, async (req, res) => {
  try { await axios.delete(`${SUPABASE_URL}/rest/v1/movimientos_tc?id=eq.${req.params.id}`, { headers: SUPA_HEADERS }); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Finanzas: Notas del mes ──
app.get("/notas_mes", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/notas_mes?mes=eq.${mes}&anio=eq.${anio}`, { headers: SUPA_HEADERS });
    res.json({ nota: r.data[0]?.nota || "" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/notas_mes", auth, async (req, res) => {
  try {
    const { mes, anio, nota } = req.body;
    const existing = await axios.get(`${SUPABASE_URL}/rest/v1/notas_mes?mes=eq.${mes}&anio=eq.${anio}`, { headers: SUPA_HEADERS });
    if (existing.data && existing.data.length > 0) {
      await axios.patch(`${SUPABASE_URL}/rest/v1/notas_mes?mes=eq.${mes}&anio=eq.${anio}`, { nota }, { headers: SUPA_HEADERS });
    } else {
      await axios.post(`${SUPABASE_URL}/rest/v1/notas_mes`, { mes, anio, nota }, { headers: SUPA_HEADERS });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Finanzas: Gastos directos (pagos manuales que NO son TC) ──
// Usan tabla ingresos con monto negativo y tipo "Gasto directo"
app.get("/gastos_directos", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/ingresos?mes=eq.${mes}&anio=eq.${anio}&tipo=eq.Gasto directo&order=created_at.desc`,
      { headers: SUPA_HEADERS }
    );
    res.json({ gastos: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/gastos_directos", auth, async (req, res) => {
  try {
    const { categoria, descripcion, mes, anio, monto, moneda } = req.body;
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/ingresos`, {
      tipo: "Gasto directo",
      descripcion: `[${categoria}] ${descripcion}`,
      mes: parseInt(mes), anio: parseInt(anio),
      monto: -(Math.abs(parseFloat(monto)||0)),
      moneda: moneda || "CLP"
    }, { headers: SUPA_HEADERS });
    res.json({ gasto: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/gastos_directos/:id", auth, async (req, res) => {
  try {
    await axios.delete(`${SUPABASE_URL}/rest/v1/ingresos?id=eq.${req.params.id}`, { headers: SUPA_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
