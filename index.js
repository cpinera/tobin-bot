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

// ══════════════════════════════════════════════════════════════
// ENDPOINT: POST /analizar-tc
// ══════════════════════════════════════════════════════════════
app.post("/analizar-tc", auth, async (req, res) => {
  try {
    const { base64, mimeType, tarjeta, periodo, gfCatalog } = req.body;
    if (!base64 || !mimeType) return res.status(400).json({ error: "Falta archivo" });

    const isPDF = mimeType === "application/pdf";
    const contentBlock = isPDF
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image",    source: { type: "base64", media_type: mimeType, data: base64 } };

    const gfRef = (gfCatalog || []).map((r, i) => `${i+1}:${r[1]}(${r[0]})`).join(",");

    const sysLines = [
      "Eres un asistente financiero personal analizando movimientos de tarjeta de credito para Cristobal.",
      "Lee el periodo de facturacion del documento y detecta mes/anio real.",
      "1. Extraer TODOS los movimientos de compras (ignorar pagos/abonos al banco)",
      "2. Cruzar con gastos fijos: " + gfRef,
      "3. Categorizar en: Alimentacion Familia, Viajes, Ropa/Shopping, Salud, Software, Deporte, Restaurantes, Transporte, Entretenimiento, Educacion, Hogar, Otros",
      "REGLAS:",
      "- Uber Eats + Supermercado (Jumbo/Tottus/Unimarc) = Alimentacion Familia",
      "- COPEC / ARAMCO / bencina = Transporte",
      "- MISCELANEO SPA = Restaurantes (es un restaurant, NO spa)",
      "- Club de Golf Los Leones = item_id 22 es_gasto_fijo:true",
      "- Starlink = item_id 9 es_gasto_fijo:true",
      "- Colegio Cordillera = item_id 18, VMA = item_id 17, Cantagallo = item_id 19 es_gasto_fijo:true",
      "- PAT CONSORCIO GENALE = item_id 23 es_gasto_fijo:true",
      "- MOTION = Deporte (gimnasio)",
      "- Clinica / UC Christus / Hospital = Salud",
      "- Booking.com / LATAM / Kiwi.com = Viajes",
      "CAMPO dudosos: indices (0-based) de movimientos con monto >30000 CLP o >30 USD con descripcion ambigua.",
      'Responde SOLO JSON: {"periodo_detectado":"Marzo 2026","mes_detectado":3,"anio_detectado":2026,"movimientos":[{"fecha":"2026-03-05","descripcion":"VMA","monto":781536,"moneda":"CLP","categoria":"Colegios","gf_item_id":17,"es_gasto_fijo":true,"revisado":true}],"dudosos":[],"total":0,"resumen":""}'
    ];
    const sysPrompt = sysLines.join("\n");

    const anthropicResp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: sysPrompt,
        messages: [{
          role: "user",
          content: [
            contentBlock,
            { type: "text", text: `Analiza este estado de cuenta de ${tarjeta} del periodo ${periodo}. Detecta el periodo real del documento.` }
          ]
        }]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "pdfs-2024-09-25",
          "content-type": "application/json"
        }
      }
    );

    const raw = (anthropicResp.data.content || []).map(b => b.text || "").join("");
    const jm = raw.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error("Claude no devolvio JSON. Inicio: " + raw.slice(0, 200));

    let result;
    try {
      result = JSON.parse(jm[0]);
    } catch(parseErr) {
      console.error("JSON truncado, recuperando...");
      const movMatch = jm[0].match(/"movimientos"\s*:\s*(\[[\s\S]*)/);
      if (movMatch) {
        let partial = movMatch[1];
        const opens  = (partial.match(/\{/g) || []).length;
        const closes = (partial.match(/\}/g) || []).length;
        for (let i = 0; i < opens - closes; i++) partial += "}";
        if (!partial.trim().endsWith("]")) partial += "]";
        try {
          result = { movimientos: JSON.parse(partial), dudosos: [], total: 0, resumen: "Analisis parcial", mes_detectado: null, anio_detectado: null };
        } catch(e2) {
          throw new Error("JSON invalido: " + parseErr.message);
        }
      } else {
        throw new Error("JSON truncado sin movimientos recuperables");
      }
    }

    res.json({ ok: true, ...result });
  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error("Error /analizar-tc:", detail);
    res.status(500).json({ error: e.message, detail: e.response?.data || null });
  }
});

// ── Finanzas endpoints (GF, Ingresos, Movimientos TC, Notas) ──
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

app.get("/ingresos", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/ingresos?mes=eq.${mes}&anio=eq.${anio}&order=created_at.desc`, { headers: SUPA_HEADERS });
    res.json({ ingresos: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/ingresos", auth, async (req, res) => {
  try {
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/ingresos`, req.body, { headers: SUPA_HEADERS });
    res.json({ ingreso: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/ingresos/:id", auth, async (req, res) => {
  try { await axios.delete(`${SUPABASE_URL}/rest/v1/ingresos?id=eq.${req.params.id}`, { headers: SUPA_HEADERS }); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/movimientos_tc", auth, async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/movimientos_tc?mes=eq.${mes}&anio=eq.${anio}&order=monto.desc`, { headers: SUPA_HEADERS });
    res.json({ movimientos: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/movimientos_tc", auth, async (req, res) => {
  try {
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/movimientos_tc`, req.body, { headers: SUPA_HEADERS });
    res.json({ movimiento: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
