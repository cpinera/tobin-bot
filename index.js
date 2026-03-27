const express = require("express");
const { getGmailAuthUrl, saveGmailTokens, getEmailBatch, getEmailBody } = require("./gmail");
const { scanEmails, executeApproved, skipEmails, moveEmail, scheduleEmailScans } = require("./email-agent");
const { CALENDAR_TOOLS, executeCalendarTool, getOAuth2Client, setTokens } = require("./calendar");
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
    valor:     row.valor    || 5,
    esfuerzo:  row.esfuerzo || 5,
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
    cuota_list: data.cuotaList || [],
    valor:     data.valor    || 5,
    esfuerzo:  data.esfuerzo || 5
  }, { headers: SUPA_HEADERS });
  const row = res.data[0];
  return { id:row.id, nombre:row.nombre, estado:row.estado, urgencia:row.urgencia, fecha:row.fecha, monto:row.monto, cuotas:row.cuotas, cuotaList:row.cuota_list||[], valor:row.valor||5, esfuerzo:row.esfuerzo||5, createdAt:row.created_at };
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
  const res = await axios.patch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, body, { headers: SUPA_HEADERS });
  const row = res.data[0];
  return { id:row.id, nombre:row.nombre, estado:row.estado, urgencia:row.urgencia, fecha:row.fecha, monto:row.monto, cuotas:row.cuotas, cuotaList:row.cuota_list||[], valor:row.valor||5, esfuerzo:row.esfuerzo||5 };
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
const TOOLS = [...CALENDAR_TOOLS,
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
  if (["list_events","create_event","delete_event","list_calendars"].includes(name)) {
    try { return await executeCalendarTool(name, input); }
    catch(e) { return { ok:false, message: e.message }; }
  }
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
  const today = new Date().toLocaleDateString("es-CL", {weekday:"long",year:"numeric",month:"long",day:"numeric",timeZone:"America/Santiago"});
  const todayISO = new Date().toLocaleDateString("en-CA", {timeZone:"America/Santiago"});
  const systemPrompt = `Eres un asistente de productividad personal que gestiona el to-do list del usuario.
Eres conciso, amable y respondes en español.
Hoy es ${today} (${todayISO}). Usa SIEMPRE esta fecha como referencia para calcular fechas relativas como "hoy", "mañana", "el viernes", etc.
Para listar tareas usa este formato:
• #ID EMOJI *Nombre* — URGENCIA
Estados: ⏳ Pendiente | 🔄 En progreso | ✅ Listo
Urgencia: 🔴 Alta | 🟡 Media | 🟢 Baja
Cuando el usuario pida agregar MÚLTIPLES tareas, llama create_task individualmente por cada una.
Para eventos de calendario, las fechas en ISO 8601 con timezone Chile: ${todayISO}T14:00:00-03:00
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

// ── Gmail OAuth ───────────────────────────────────────────────
app.get('/gmail/start', (req, res) => res.redirect(getGmailAuthUrl()));

app.get('/gmail/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { google } = require('googleapis');
    const oauth2 = new (require('googleapis').google.auth.OAuth2)(
      process.env.GCAL_CLIENT_ID, process.env.GCAL_CLIENT_SECRET,
      'https://tobin-bot-production.up.railway.app/gmail/callback'
    );
    const { tokens } = await oauth2.getToken(code);
    await saveGmailTokens(tokens);
    res.send('<h2>✅ Gmail conectado</h2><p>Puedes cerrar esta ventana.</p>');
  } catch(e) { res.send('<h2>Error: ' + e.message + '</h2>'); }
});

// ── Email API ─────────────────────────────────────────────────
app.get('/emails', auth, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const emails = await getEmailBatch(status);
    res.json({ emails });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/scan', auth, async (req, res) => {
  try {
    const result = await scanEmails(req.body.hours || 13, sendTelegramMessage);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/execute', auth, async (req, res) => {
  try {
    const { gmailIds } = req.body;
    console.log("Ejecutando emails:", gmailIds);
    const result = await executeApproved(gmailIds);
    console.log("Resultado:", result);
    res.json(result);
  } catch(e) {
    console.error("Error en /emails/execute:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/emails/skip', auth, async (req, res) => {
  try {
    const { gmailIds } = req.body;
    await skipEmails(gmailIds);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/move', auth, async (req, res) => {
  try {
    const { gmailId, classification } = req.body;
    await moveEmail(gmailId, classification);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/emails/scan-now', auth, async (req, res) => {
  try {
    const result = await scanEmails(48, sendTelegramMessage);
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/emails/:gmailId/body', auth, async (req, res) => {
  try {
    const body = await getEmailBody(req.params.gmailId);
    res.json({ body });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/emails/:gmailId', auth, async (req, res) => {
  try {
    const { updateEmail } = require('./gmail');
    await updateEmail(req.params.gmailId, req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/oauth/start', (req, res) => {
  const oauth2 = getOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    setTokens(tokens);
    console.log('Google Calendar autorizado');
    res.send('<h2>Google Calendar conectado</h2><p>Puedes cerrar esta ventana.</p>');
  } catch(e) {
    res.send('<h2>Error: ' + e.message + '</h2>');
  }
});

// ── Expense helpers ───────────────────────────────────────────
const { processExpense } = require('./expense-agent');

async function downloadTelegramFile(fileId) {
  const infoRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = infoRes.data.result.file_path;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const fileRes = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(fileRes.data);
}

function buildExpenseReply(result) {
  let msg = `✅ Gasto registrado en Airtable\n\n`;
  msg += `📌 Item: ${result.item}\n`;
  msg += `📅 Fecha: ${result.fechaGasto}\n`;
  msg += `🗓 Mes: ${result.mes} ${result.anio}\n`;
  msg += `💰 Total: $${result.totalCLP.toLocaleString('es-CL')} CLP`;
  if (result.monedaOriginal === 'USD') {
    msg += `\n   (USD ${result.totalOriginal} x $${Math.round(result.usdRate).toLocaleString('es-CL')} = CLP)`;
  }
  msg += `\n📎 Respaldo: imagen subida`;
  return msg;
}

// ── Webhook ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;

  // Foto enviada directamente
  if (msg.photo) {
    await sendMessage(chatId, '⏳ Procesando boleta...');
    try {
      const photo = msg.photo.at(-1);
      const buffer = await downloadTelegramFile(photo.file_id);
      const result = await processExpense(buffer, 'image/jpeg', `boleta_${Date.now()}.jpg`, msg.date);
      await sendMessage(chatId, buildExpenseReply(result));
    } catch(e) {
      console.error('Error foto:', e.message);
      await sendMessage(chatId, `❌ Error procesando imagen: ${e.message}`);
    }
    return;
  }

  // Documento (PDF o imagen como archivo)
  if (msg.document) {
    const doc = msg.document;
    const accepted = ['application/pdf','image/jpeg','image/png','image/jpg','image/webp'];
    if (!accepted.includes(doc.mime_type)) {
      await sendMessage(chatId, '⚠️ Solo acepto fotos o PDFs para registrar gastos.');
      return;
    }
    await sendMessage(chatId, '⏳ Procesando documento...');
    try {
      const buffer = await downloadTelegramFile(doc.file_id);
      const fileName = doc.file_name || `doc_${Date.now()}`;
      const result = await processExpense(buffer, doc.mime_type, fileName, msg.date);
      await sendMessage(chatId, buildExpenseReply(result));
    } catch(e) {
      console.error('Error documento:', e.message);
      await sendMessage(chatId, `❌ Error procesando documento: ${e.message}`);
    }
    return;
  }

  // Texto (comportamiento original)
  if (msg.text) {
    try {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const reply = await runAgent(chatId, msg.text);
      await sendMessage(chatId, reply);
    } catch(e) {
      console.error("Agent error:", e.response?.data || e.message);
      await sendMessage(chatId, "❌ Ocurrió un error. Intenta de nuevo.");
    }
  }
});

const RESEND_KEY = process.env.RESEND_KEY;
const EMAIL_TO   = process.env.EMAIL_TO;

async function sendDailyDigest() {
  try {
    const tasks = await dbGetAll();
    const pending = tasks.filter(t => t.estado !== "Listo");
    const top3 = [...pending]
      .map(t => ({ ...t, score: (t.valor||5) / (t.esfuerzo||5) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 3);

    if (!top3.length) return console.log("No hay tareas pendientes.");

    const today = new Date().toLocaleDateString("es-CL", {
      weekday:"long", year:"numeric", month:"long", day:"numeric", timeZone:"America/Santiago"
    });
    const todayCap = today.charAt(0).toUpperCase() + today.slice(1);
    const dateShort = new Date().toLocaleDateString("es-CL", {
      day:"2-digit", month:"2-digit", year:"numeric", timeZone:"America/Santiago"
    });

    const rows = top3.map((t, i) => {
      const score = Math.round(t.score * 10) / 10;
      const estado = t.estado === "En progreso" ? "🔄 En progreso" : "⏳ Pendiente";
      const numColor   = i===0 ? "#1a73e8" : i===1 ? "#34a853" : "#f29900";
      const scoreColor = score >= 2 ? "#1e8e3e" : score >= 1 ? "#f29900" : "#5f6368";
      const scoreBg    = score >= 2 ? "#e6f4ea" : score >= 1 ? "#fef7e0" : "#f1f3f4";
      return `<div style="padding:20px 24px;border-bottom:1px solid #e8eaed">
        <div style="display:flex;align-items:flex-start;gap:14px">
          <div style="min-width:28px;height:28px;border-radius:50%;background:${numColor};color:#fff;font-size:13px;font-weight:700;text-align:center;line-height:28px;flex-shrink:0">${i+1}</div>
          <div style="flex:1">
            <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#202124;line-height:1.4">${t.nombre}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <span style="font-size:12px;color:#5f6368">${estado}</span>
              <span style="color:#dadce0;font-size:12px">·</span>
              <span style="font-size:12px;color:#5f6368">Valor ${t.valor||5} / Esfuerzo ${t.esfuerzo||5}</span>
              <span style="color:#dadce0;font-size:12px">·</span>
              <span style="background:${scoreBg};color:${scoreColor};font-size:12px;font-weight:700;padding:2px 10px;border-radius:12px">Score ${score}</span>
              ${t.fecha ? `<span style="color:#dadce0;font-size:12px">·</span><span style="font-size:12px;color:#5f6368">📅 ${t.fecha}</span>` : ""}
            </div>
          </div>
        </div>
      </div>`;
    }).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8f9fa;font-family:Roboto,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="margin-bottom:24px">
      <p style="margin:0 0 4px;font-size:12px;color:#5f6368;letter-spacing:0.5px;text-transform:uppercase;font-weight:600">To-Do diario</p>
      <h1 style="margin:0;font-size:26px;font-weight:700;color:#202124">${todayCap}</h1>
    </div>
    <div style="background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(60,64,67,0.12);overflow:hidden;margin-bottom:20px">
      <div style="padding:14px 24px;border-bottom:1px solid #e8eaed;background:#f8f9fa">
        <p style="margin:0;font-size:11px;font-weight:600;color:#5f6368;letter-spacing:0.5px;text-transform:uppercase">Tus 3 tareas prioritarias</p>
      </div>
      ${rows}
      <div style="padding:14px 24px;background:#f8f9fa">
        <p style="margin:0;font-size:13px;color:#5f6368">${pending.length} tareas pendientes en total</p>
      </div>
    </div>
    <div style="text-align:center;margin-bottom:28px">
      <a href="https://tobin-todo-web.vercel.app" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;padding:11px 32px;border-radius:8px;font-size:14px;font-weight:600">Ver todas las tareas →</a>
    </div>
    <p style="text-align:center;font-size:12px;color:#9aa0a6;margin:0">To-Do Tobin · <a href="https://tobin-todo-web.vercel.app" style="color:#9aa0a6;text-decoration:none">tantauco.vc</a></p>
  </div>
</body></html>`;

    await axios.post("https://api.resend.com/emails", {
      from:    "To-Do Tobin <noreply@tantauco.vc>",
      to:      EMAIL_TO,
      subject: `To-Do ${dateShort}`,
      html
    }, {
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }
    });

    console.log("Email diario enviado a", EMAIL_TO);
  } catch(e) {
    console.error("Error enviando email:", e.response?.data || e.message);
  }
}

function scheduleDailyEmail() {
  function msUntilNext11UTC() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(11, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  const ms = msUntilNext11UTC();
  console.log(`Email programado en ${Math.round(ms/1000/60)} minutos (11:00 UTC = 07:00 Chile)`);
  setTimeout(() => {
    sendDailyDigest();
    setInterval(sendDailyDigest, 24 * 60 * 60 * 1000);
  }, ms);
}

scheduleDailyEmail();
scheduleEmailScans(sendTelegramMessage);

// ── Cuentas API ───────────────────────────────────────────────
app.get('/cuentas', auth, async (req, res) => {
  try {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/cuentas?order=nombre`, { headers: SUPA_HEADERS });
    res.json({ cuentas: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/cuentas', auth, async (req, res) => {
  try {
    const { nombre, mes, anio, monto, estado } = req.body;
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/cuentas`, { nombre, mes, anio, monto: monto||0, estado: estado||'Por pagar' }, { headers: SUPA_HEADERS });
    res.json({ cuenta: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/cuentas/:id', auth, async (req, res) => {
  try {
    const r = await axios.patch(`${SUPABASE_URL}/rest/v1/cuentas?id=eq.${req.params.id}`, req.body, { headers: SUPA_HEADERS });
    res.json({ cuenta: r.data[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/cuentas/:id', auth, async (req, res) => {
  try {
    await axios.delete(`${SUPABASE_URL}/rest/v1/cuentas?id=eq.${req.params.id}`, { headers: SUPA_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/send-digest", (req, res) => {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  sendDailyDigest();
  res.json({ ok: true, message: "Enviando digest..." });
});

app.get("/", (req, res) => res.send("Bot activo ✓"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));

// ── Proactive Telegram Notifications ─────────────────────────
const CHAT_ID = process.env.CHAT_ID || "7783704824";

async function sendTelegramMessage(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "Markdown"
  });
}

async function sendMorningBriefing() {
  try {
    const tasks = await dbGetAll();
    const pending = tasks.filter(t => t.estado !== "Listo");
    const top3 = [...pending]
      .map(t => ({ ...t, score: (t.valor||5)/(t.esfuerzo||5) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 3);

    const dateStr = new Date().toLocaleDateString("es-CL", {
      weekday:"long", day:"numeric", month:"long", timeZone:"America/Santiago"
    });
    const dateCap = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

    let lines = ["*Buenos dias!*", "_" + dateCap + "_", ""];

    if (top3.length) {
      lines.push("*Top 3 tareas de hoy:*");
      const medals = ["1.", "2.", "3."];
      top3.forEach((t,i) => {
        const score = Math.round((t.valor||5)/(t.esfuerzo||5)*10)/10;
        lines.push(medals[i] + " " + t.nombre + " (score: " + score + ")");
      });
    } else {
      lines.push("No tienes tareas pendientes!");
    }

    try {
      const calMod = require("./calendar");
      const result = await calMod.executeCalendarTool("list_events", { days: 1 });
      if (result.events && result.events.length) {
        lines.push("");
        lines.push("*Eventos de hoy:*");
        result.events.forEach(e => {
          const time = e.start ? new Date(e.start).toLocaleTimeString("es-CL", {
            hour:"2-digit", minute:"2-digit", timeZone:"America/Santiago"
          }) : "";
          lines.push("- " + time + " " + e.summary);
        });
      }
    } catch(e) { /* calendar not connected */ }

    await sendTelegramMessage(lines.join("\n"));
    console.log("Morning briefing enviado");
  } catch(e) {
    console.error("Error morning briefing:", e.message);
  }
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
        const timeStr = start.toLocaleTimeString("es-CL", {
          hour:"2-digit", minute:"2-digit", timeZone:"America/Santiago"
        });
        await sendTelegramMessage(
          "Recordatorio: *" + event.summary + "* empieza en " + Math.round(diffMin) + " minutos (" + timeStr + ")"
        );
        console.log("Recordatorio enviado:", event.summary);
      }
    }
    if (notifiedEvents.size > 200) notifiedEvents.clear();
  } catch(e) { /* calendar not connected yet */ }
}

function scheduleMorningBriefing() {
  function msUntilNext11UTC() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(11, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  const ms = msUntilNext11UTC();
  console.log("Morning briefing programado en " + Math.round(ms/1000/60) + " min (11:00 UTC = 07:00 Chile)");
  setTimeout(() => {
    sendMorningBriefing();
    setInterval(sendMorningBriefing, 24 * 60 * 60 * 1000);
  }, ms);
}

setInterval(checkCalendarReminders, 5 * 60 * 1000);
scheduleMorningBriefing();

app.get("/send-briefing", (req, res) => {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  sendMorningBriefing();
  res.json({ ok: true, message: "Enviando briefing..." });
});
