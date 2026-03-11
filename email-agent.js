const axios = require("axios");
const { fetchNewEmails, saveEmailBatch, getEmailBatch, updateEmail, archiveEmail, markAsSpam, deleteEmail, createDraft, sendEmail, applyLabel, starEmail, labelPrioritario, isConnected } = require("./gmail");

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

const SYSTEM_PROMPT = `Eres el asistente de email de Cristóbal, socio de Tantauco Ventures, un fondo de VC en Chile.

EMPRESAS DEL PORTFOLIO DE TANTAUCO VENTURES:
- Pulpos, Mutuus, Buo, Spakio, Kunzapp, Meki, Koywe, Luable, Flipzen, SOMOS, Legria, Justt, Anyroad, CxC, Foodology, Wibo, Scape, Hackmetrix, Spot, Mission Hires, Influur, Grupalia, Boe, Wareclouds

SOLO HAY 3 CATEGORÍAS POSIBLES:

1. auto_reply — Emails que requieren respuesta automática:
   - Pitchs de startups buscando inversión (en cualquier idioma)
   - Ofertas de servicios, software, consultoría, agencias
   - Cualquier email comercial o de ventas no solicitado

2. spam — Emails a eliminar:
   - Newsletters y publicidad masiva
   - Notificaciones automáticas de plataformas (LinkedIn, DocuSign, Notion, calendarios, etc)
   - Confirmaciones automáticas sin acción requerida
   - Cualquier email masivo o automatizado que no sea pitch/servicio

3. priorizado — Emails de trabajo que Cristóbal revisará en Gmail:
   - Emails personalizados dirigidos a Cristóbal por nombre
   - Reportes o actualizaciones de empresas del portfolio
   - Emails de VCs, inversores, family offices
   - Cualquier email que requiera atención personal de Cristóbal

REGLAS DE ACCIÓN:
- auto_reply → accion: "auto_reply", genera borrador en el mismo idioma del email recibido
- spam → accion: "marcar_spam"
- priorizado → accion: "estrella"

BORRADORES PARA AUTO_REPLY:

Si es pitch de startup en español:
"Hola, muchas gracias por compartir la oportunidad. (este es un mail automatico)
Toda inversion que realiza nuestro fondo sin excepcion, debe partir por rellenar el formulario en nuestro sitio www.tantauco.vc, desde ese punto te contactaremos en 7-14 dias.
Saludos!
Cristobal"

Si es pitch de startup en inglés:
"Hi, thank you for sharing this opportunity. (this is an automated reply)
Every investment our fund considers, without exception, must start by filling out the form on our website www.tantauco.vc. From there, we will be in touch within 7-14 business days.
Best,
Cristobal"

Si es oferta de servicios en español:
"Hola, muchas gracias pero no estamos interesados por ahora.
Saludos,
Cristobal"

Si es oferta de servicios en inglés:
"Hi, thank you for reaching out but we are not interested at this time.
Best,
Cristobal"

IMPORTANTE:
- Si hay duda entre SPAM y AUTO_REPLY, elige AUTO_REPLY
- Si hay duda entre SPAM y PRIORIZADO, elige PRIORIZADO
- Solo usa SPAM cuando estés seguro de que es masivo/automatizado`;

async function classifyEmails(emails) {
  const learningCtx = await getLearningContext();
  const userPrompt = `Clasifica estos emails. Responde SOLO con JSON array sin markdown ni texto extra:
${learningCtx ? learningCtx + "\n\n" : ""}
[{"gmail_id":"...","classification":"auto_reply|spam|priorizado","action":"auto_reply|marcar_spam|estrella","draft_reply":"texto o null","reason":"1 línea explicando por qué"}]

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

async function scanEmails(sinceHours = 13, sendTelegramCb = null) {
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
        classification: cls.classification || "spam",
        action:         cls.action || "marcar_spam",
        draft_reply:    cls.draft_reply || null,
        ai_reason:      cls.reason || "",
        status:         "pending"
      };
    });

    await saveEmailBatch(toSave);
    const autoReply  = toSave.filter(e => e.classification === "auto_reply").length;
    const priorizado = toSave.filter(e => e.classification === "priorizado").length;
    const spam       = toSave.filter(e => e.classification === "spam").length;
    console.log(`Scan completo: ${toSave.length} emails (${autoReply} auto_reply, ${priorizado} priorizado, ${spam} spam)`);

    if (toSave.length > 0 && sendTelegramCb) {
      const lines = ["📧 *Revisión de emails*", ""];
      if (priorizado > 0)  lines.push(`🔴 *Priorizado:* ${priorizado}`);
      if (autoReply > 0)   lines.push(`✍️ *Respuesta automática:* ${autoReply}`);
      if (spam > 0)        lines.push(`⛔ *Spam:* ${spam}`);
      lines.push("");
      lines.push(`📬 *Total:* ${toSave.length} emails`);
      lines.push("");
      lines.push(`👉 [Revisar en la app](https://tobin-todo-web.vercel.app)`);
      await sendTelegramCb(lines.join("\n"));
    }

    return { count: toSave.length, autoReply, priorizado, spam };
  } catch(e) {
    console.error("Error en scan:", e.message);
    return { count: 0, error: e.message };
  }
}

async function executeApproved(gmailIds) {
  const SUPA_H = { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}`, "Content-Type": "application/json" };
  const r = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/email_inbox?or=(${gmailIds.map(id=>`gmail_id.eq.${id}`).join(",")})&limit=200`, { headers: SUPA_H });
  const emails = r.data || [];
  console.log(`Ejecutando ${emails.length} emails de ${gmailIds.length} solicitados`);
  const done = [], errors = [];

  for (const email of emails) {
    try {
      const correction = email.user_correction ? JSON.parse(email.user_correction) : null;
      const classification = correction?.classification || email.classification;
      const action = correction?.action || email.action;
      const draftReply = correction?.draft_reply || email.draft_reply;

      // Spam: always delete, optionally also mark as spam in Gmail
      if (classification === "spam") {
        const markSpam = correction?.markAsSpam === true;
        if (markSpam) await markAsSpam(email.gmail_id);
        await deleteEmail(email.gmail_id);
      }

      // Priorizado: star in Gmail
      if (action === "estrella") {
        await starEmail(email.gmail_id);
        await labelPrioritario(email.gmail_id);
      }

      if (action === "auto_reply" && draftReply) {
        const to = email.from_email.match(/<(.+)>/)?.[1] || email.from_email;
        await sendEmail(to, email.subject, draftReply, email.thread_id);
        await archiveEmail(email.gmail_id);
      }

      await updateEmail(email.gmail_id, { status: "approved" });
      await savePattern(email, correction);
      done.push(email.gmail_id);
    } catch(e) {
      console.error("Error ejecutando acción:", e.message);
      errors.push(email.gmail_id);
    }
  }
  return { done: done.length, errors: errors.length };
}

async function moveEmail(gmailId, newClassification) {
  const actionMap = {
    auto_reply:  "auto_reply",
    spam:        "marcar_spam",
    priorizado:  "estrella"
  };
  const correction = {
    classification: newClassification,
    action: actionMap[newClassification] || "marcar_spam"
  };

  // Load existing draft if moving to auto_reply
  const SUPA_H = { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` };
  const r = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/email_inbox?gmail_id=eq.${gmailId}`, { headers: SUPA_H });
  const email = r.data?.[0];
  if (email) {
    const existingCorr = email.user_correction ? JSON.parse(email.user_correction) : null;
    correction.draft_reply = existingCorr?.draft_reply || email.draft_reply || null;
    await savePattern(email, correction); // save as learning signal
  }

  await updateEmail(gmailId, { user_correction: JSON.stringify(correction) });
  return correction;
}

async function skipEmails(gmailIds) {
  for (const id of gmailIds) await updateEmail(id, { status: "skipped" });
}

function scheduleEmailScans(sendTelegram) {
  function msUntilNext(utcHour) {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(utcHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  async function runScan(label) {
    console.log(`Scan de emails ${label}...`);
    await scanEmails(13, sendTelegram);
  }

  setTimeout(() => { runScan("mañana"); setInterval(() => runScan("mañana"), 24 * 60 * 60 * 1000); }, msUntilNext(12));
  setTimeout(() => { runScan("tarde");  setInterval(() => runScan("tarde"),  24 * 60 * 60 * 1000); }, msUntilNext(18));
  console.log(`Scans programados: 09:00 y 15:00 Chile`);
}

// ── Learning system ────────────────────────────────────────────
async function savePattern(email, correction) {
  const SUPA_H = { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" };
  const finalCls = correction?.classification || email.classification;
  const pattern = {
    gmail_id:             email.gmail_id,
    from_email:           email.from_email,
    subject:              email.subject,
    ai_classification:    email.classification,
    final_classification: finalCls,
    ai_action:            email.action,
    final_action:         correction?.action || email.action,
    was_corrected:        !!(correction && correction.classification !== email.classification),
    draft_used:           !!(correction?.draft_reply || email.draft_reply),
    created_at:           new Date().toISOString()
  };
  try {
    await axios.post(`${process.env.SUPABASE_URL}/rest/v1/email_patterns`, pattern, { headers: SUPA_H });
  } catch(e) { /* silent */ }
}

async function getLearningContext() {
  const SUPA_H = { "apikey": process.env.SUPABASE_KEY, "Authorization": `Bearer ${process.env.SUPABASE_KEY}` };
  try {
    const r = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/email_patterns?order=created_at.desc&limit=50`, { headers: SUPA_H });
    const patterns = r.data || [];
    const corrections = patterns.filter(p => p.was_corrected);
    if (!corrections.length) return "";

    const lines = ["CORRECCIONES PREVIAS DE CRISTÓBAL (aprende de estos patrones):"];
    corrections.slice(0, 20).forEach(p => {
      lines.push(`- "${p.subject}" de ${p.from_email}: AI clasificó como "${p.ai_classification}" pero Cristóbal lo movió a "${p.final_classification}"`);
    });
    return lines.join("\n");
  } catch(e) { return ""; }
}

module.exports = { scanEmails, executeApproved, moveEmail, skipEmails, scheduleEmailScans };
