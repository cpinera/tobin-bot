const axios = require("axios");
const { fetchNewEmails, saveEmailBatch, getEmailBatch, updateEmail, archiveEmail, markAsSpam, createDraft, applyLabel, starEmail, labelPrioritario, isConnected } = require("./gmail");

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

const SYSTEM_PROMPT = `Eres el asistente de email de Cristóbal, socio de Tantauco Ventures, un fondo de VC en Chile.

EMPRESAS DEL PORTFOLIO DE TANTAUCO VENTURES:
- Pulpos (pulpos.com)
- Mutuus (ps-mutuus.com)
- Buo (getbuo.com)
- Spakio (spakio.com)
- Kunzapp (kunzapp.com)
- Meki (mekiapp.com)
- Koywe (koywe.eco)
- Luable (mejorcdt.com)
- Flipzen (flip-flow.com)
- SOMOS (somosinternet.co)
- Legria (legria.cl)
- Justt (justt.ai)
- Anyroad (anyroad.com)
- CxC (cxc.com.mx)
- Foodology (foodology.com.co)
- Wibo (soywibo.com)
- Scape (scape.mx)
- Hackmetrix (hackmetrix.com)
- Spot (spotcloud.io)
- Mission Hires (fixmytravel.com)
- Influur (influur.com)
- Grupalia (grupalia.com)
- Boe (app.boe.cl)
- Wareclouds (wareclouds.com)

Si el remitente tiene un dominio de estas empresas, O menciona el nombre de la empresa en el asunto/cuerpo enviando reportes, métricas, actualizaciones o noticias → clasificar como URGENTE.

REGLAS DE CLASIFICACION:

URGENTE:
- Emails en español, claramente personalizados y dirigidos a Cristóbal por nombre
- Reportes o actualizaciones de empresas del portfolio de Tantauco
- Emails que claramente NO son automatizados y van dirigidos a el personalmente
- Respuestas a conversaciones previas importantes

UTIL:
- Emails de VCs, inversores, family offices
- Invitaciones a eventos del ecosistema VC/startup
- Noticias relevantes del sector que alguien envio personalmente
- Emails institucionales importantes (legales, regulatorios)

POCO UTIL:
- Correos bancarios rutinarios
- Notificaciones de plataformas (DocuSign, Notion, etc)
- Confirmaciones automaticas
- FYI sin accion requerida

SPAM:
- Newsletters masivos
- Publicidad y promociones
- Notificaciones de redes sociales (LinkedIn, Twitter, etc)
- Cualquier email que claramente sea masivo o automatizado

RESPUESTA AUTOMATICA tipo "cold_call_startup":
Detectar: email presentando una startup buscando inversion, especialmente en ingles.
Accion: "responder"

Borrador si el email es en español:
"Hola, muchas gracias por compartir la oportunidad. (este es un mail automatico)

Toda inversion que realiza nuestro fondo sin excepcion, debe partir por rellenar el formulario en nuestro sitio www.tantauco.vc, desde ese punto te contactaremos en 7-14 dias.

Saludos!
Cristobal"

Borrador si el email es en ingles:
"Hi, thank you for sharing this opportunity. (this is an automated reply)

Every investment our fund considers, without exception, must start by filling out the form on our website www.tantauco.vc. From there, we will be in touch within 7-14 business days.

Best,
Cristobal"

RESPUESTA AUTOMATICA tipo "venta_servicios":
Detectar: email vendiendo servicios, software, consultoria, agencias, etc.
Accion: "responder"

Borrador si el email es en español:
"Hola, muchas gracias pero no estamos interesados por ahora.
Saludos,
Cristobal"

Borrador si el email es en ingles:
"Hi, thank you for reaching out but we are not interested at this time.
Best,
Cristobal"

REGLAS DE ACCION:
- urgente → accion: "responder" (genera borrador contextual personalizado) + se marcará con estrella y etiqueta Prioritario en Gmail
- util → accion: "etiquetar_util"
- poco_util → accion: "archivar"
- spam → accion: "marcar_spam"
- cold_call_startup → clasificacion: "poco_util", accion: "responder" con template formulario
- venta_servicios → clasificacion: "poco_util", accion: "responder" con template no interesado

IMPORTANTE:
- Si el email NO menciona explicitamente a Cristobal por nombre y parece masivo, NO es urgente
- Prioriza identificar si el email es automatizado/masivo vs personal
- Para borradores usa el mismo idioma del email recibido
- Tono semi-formal: "Hola [nombre]" en español, "Hi [name]" en ingles`;

async function classifyEmails(emails) {
  const userPrompt = `Clasifica estos emails. Responde SOLO con JSON array sin markdown ni texto extra:
[{"gmail_id":"...","classification":"urgente|util|poco_util|spam","action":"responder|etiquetar_util|archivar|marcar_spam","draft_reply":"texto o null","reason":"1 línea explicando por qué"}]

Emails:
${JSON.stringify(emails.map(e => ({ id: e.id, from: e.from, subject: e.subject, snippet: e.snippet })), null, 2)}`;

  const r = await axios.post("https://api.anthropic.com/v1/messages", {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }]
  }, { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } });

  try {
    const text = r.data.content[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch(e) {
    console.error("Error parsing classification:", e.message);
    return [];
  }
}

async function scanEmails(sinceHours = 13) {
  if (!isConnected()) { console.log("Gmail no conectado"); return { count: 0 }; }
  console.log("Iniciando scan de emails...");
  try {
    const emails = await fetchNewEmails(sinceHours);
    if (!emails.length) { console.log("No hay emails nuevos"); return { count: 0 }; }
    console.log(`${emails.length} emails encontrados, clasificando...`);

    const results = [];
    for (let i = 0; i < emails.length; i += 15) {
      const batch = emails.slice(i, i + 15);
      const classified = await classifyEmails(batch);
      results.push(...classified);
    }

    const toSave = emails.map(email => {
      const cls = results.find(r => r.gmail_id === email.id) || {};
      return {
        gmail_id:       email.id,
        thread_id:      email.threadId,
        from_email:     email.from,
        subject:        email.subject,
        date:           email.date,
        snippet:        email.snippet,
        classification: cls.classification || "poco_util",
        action:         cls.action || "archivar",
        draft_reply:    cls.draft_reply || null,
        ai_reason:      cls.reason || "",
        status:         "pending"
      };
    });

    await saveEmailBatch(toSave);
    const urgentes = toSave.filter(e => e.classification === "urgente").length;
    const utiles   = toSave.filter(e => e.classification === "util").length;
    console.log(`Scan completo: ${toSave.length} emails (${urgentes} urgentes, ${utiles} útiles)`);
    return { count: toSave.length, urgentes, utiles };
  } catch(e) {
    console.error("Error en scan:", e.message);
    return { count: 0, error: e.message };
  }
}

async function executeApproved(gmailIds) {
  const SUPA_H = { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}`, "Content-Type": "application/json" };
  const r = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/email_inbox?status=eq.pending&limit=200`, { headers: SUPA_H });
  const emails = (r.data || []).filter(e => gmailIds.includes(e.gmail_id));
  const done = [], errors = [];

  for (const email of emails) {
    try {
      const correction = email.user_correction ? JSON.parse(email.user_correction) : null;
      const action = correction?.action || email.action;
      const draftReply = correction?.draft_reply || email.draft_reply;

      if (action === "archivar")       await archiveEmail(email.gmail_id);
      if (action === "marcar_spam")    await markAsSpam(email.gmail_id);
      if (action === "etiquetar_util") await applyLabel(email.gmail_id, "Útil-Tobin");
      // Urgente: star + label Prioritario
      const classification = correction?.classification || email.classification;
      if (classification === "urgente") {
        await starEmail(email.gmail_id);
        await labelPrioritario(email.gmail_id);
      }
      if (action === "responder" && draftReply) {
        const to = email.from_email.match(/<(.+)>/)?.[1] || email.from_email;
        await createDraft(email.gmail_id, email.thread_id, to, email.subject, draftReply);
      }

      await updateEmail(email.gmail_id, { status: "approved" });
      done.push(email.gmail_id);
    } catch(e) {
      console.error("Error ejecutando acción:", e.message);
      errors.push(email.gmail_id);
    }
  }
  return { done: done.length, errors: errors.length };
}

async function skipEmails(gmailIds) {
  for (const id of gmailIds) await updateEmail(id, { status: "skipped" });
}

function scheduleEmailScans(sendTelegram) {
  // Scan at 9:00 AM and 3:00 PM Chile time (12:00 UTC and 18:00 UTC)
  function msUntilNext(utcHour) {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(utcHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  async function runScan(label) {
    console.log(`Scan de emails ${label}...`);
    const result = await scanEmails(13);
    if (result.count > 0 && sendTelegram) {
      const msg = `📧 *Revisión de emails ${label}*\n${result.count} emails nuevos · ${result.urgentes || 0} urgentes · ${result.utiles || 0} útiles\n\nRevisa en: https://tobin-todo-web.vercel.app`;
      await sendTelegram(msg);
    }
  }

  // Morning scan 9:00 AM Chile (12:00 UTC)
  setTimeout(() => {
    runScan("mañana");
    setInterval(() => runScan("mañana"), 24 * 60 * 60 * 1000);
  }, msUntilNext(12));

  // Afternoon scan 3:00 PM Chile (18:00 UTC)
  setTimeout(() => {
    runScan("tarde");
    setInterval(() => runScan("tarde"), 24 * 60 * 60 * 1000);
  }, msUntilNext(18));

  console.log(`Scans programados: 09:00 y 15:00 Chile`);
}

module.exports = { scanEmails, executeApproved, skipEmails, scheduleEmailScans };
