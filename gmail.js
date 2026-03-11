const { google } = require("googleapis");
const axios = require("axios");

const GCAL_CLIENT_ID     = process.env.GCAL_CLIENT_ID;
const GCAL_CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
const GMAIL_REDIRECT_URI = "https://tobin-bot-production.up.railway.app/gmail/callback";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPA_HEADERS = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=representation"
};

let gmailTokens = null;

async function loadGmailTokens() {
  try {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/calendar_tokens?id=eq.2`, { headers: SUPA_HEADERS });
    if (r.data && r.data.length > 0) {
      gmailTokens = r.data[0].tokens;
      console.log("Gmail tokens cargados desde Supabase");
    }
  } catch(e) { console.log("No hay tokens de Gmail guardados"); }
}

async function saveGmailTokens(tokens) {
  gmailTokens = tokens;
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/calendar_tokens`, {
      id: 2, tokens, updated_at: new Date().toISOString()
    }, { headers: { ...SUPA_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" } });
    console.log("Gmail tokens guardados en Supabase");
  } catch(e) { console.error("Error guardando Gmail tokens:", e.message); }
}

function getGmailOAuth2() {
  const oauth2 = new google.auth.OAuth2(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GMAIL_REDIRECT_URI);
  if (gmailTokens) {
    oauth2.setCredentials(gmailTokens);
    oauth2.on("tokens", (t) => saveGmailTokens({ ...gmailTokens, ...t }));
  }
  return oauth2;
}

function getGmailAuthUrl() {
  return getGmailOAuth2().generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.readonly"
    ],
    prompt: "consent"
  });
}

async function getGmail() {
  if (!gmailTokens) throw new Error("Gmail no conectado. Autoriza en: https://tobin-bot-production.up.railway.app/gmail/start");
  return google.gmail({ version: "v1", auth: getGmailOAuth2() });
}

// Fetch unread emails since a date
async function fetchNewEmails(sinceHours = 12) {
  const gmail = await getGmail();
  const after = Math.floor((Date.now() - sinceHours * 3600 * 1000) / 1000);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `after:${after} -label:sent`,
    maxResults: 50
  });
  const messages = res.data.messages || [];
  const emails = [];
  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From","Subject","Date"] });
      const headers = full.data.payload.headers;
      const get = (name) => (headers.find(h => h.name === name) || {}).value || "";
      emails.push({
        id: msg.id,
        threadId: full.data.threadId,
        from: get("From"),
        subject: get("Subject"),
        date: get("Date"),
        snippet: full.data.snippet || "",
        labelIds: full.data.labelIds || []
      });
    } catch(e) { /* skip */ }
  }
  return emails;
}

// Archive email (remove INBOX label)
async function archiveEmail(emailId) {
  const gmail = await getGmail();
  await gmail.users.messages.modify({ userId: "me", id: emailId, resource: { removeLabelIds: ["INBOX"] } });
}

// Mark as spam
async function markAsSpam(emailId) {
  const gmail = await getGmail();
  await gmail.users.messages.modify({ userId: "me", id: emailId, resource: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] } });
}

// Delete email (move to trash)
async function deleteEmail(emailId) {
  const gmail = await getGmail();
  await gmail.users.messages.trash({ userId: "me", id: emailId });
}

// Create draft reply
async function createDraft(emailId, threadId, to, subject, body) {
  const gmail = await getGmail();
  const raw = makeRaw(to, subject, body, emailId);
  await gmail.users.drafts.create({ userId: "me", resource: { message: { threadId, raw } } });
}

// Add label
async function ensureLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = (list.data.labels || []).find(l => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({ userId: "me", resource: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
  return created.data.id;
}

async function applyLabel(emailId, labelName) {
  const gmail = await getGmail();
  const labelId = await ensureLabel(gmail, labelName);
  await gmail.users.messages.modify({ userId: "me", id: emailId, resource: { addLabelIds: [labelId] } });
}


async function starEmail(emailId) {
  const gmail = await getGmail();
  await gmail.users.messages.modify({ userId: "me", id: emailId, resource: { addLabelIds: ["STARRED"] } });
}

async function labelPrioritario(emailId) {
  const gmail = await getGmail();
  const labelId = await ensureLabel(gmail, "Prioritario-Tobin");
  await gmail.users.messages.modify({ userId: "me", id: emailId, resource: { addLabelIds: [labelId] } });
}


async function getEmailBody(emailId) {
  const gmail = await getGmail();
  const msg = await gmail.users.messages.get({ userId: "me", id: emailId, format: "full" });
  const payload = msg.data.payload;
  
  // Extract text body
  function extractBody(part) {
    if (!part) return "";
    if (part.mimeType === "text/plain" && part.body && part.body.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part.parts) {
      for (const p of part.parts) {
        const text = extractBody(p);
        if (text) return text;
      }
    }
    return "";
  }
  
  const body = extractBody(payload);
  // Clean up excessive whitespace
  return body.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
}


async function sendEmail(to, subject, body, threadId) {
  const gmail = await getGmail();
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const raw = makeRaw(to, replySubject, body, threadId);
  await gmail.users.messages.send({ userId: "me", resource: { threadId, raw } });
}

function makeRaw(to, subject, body, replyToId) {
  const msg = [`To: ${to}`, `Subject: Re: ${subject}`, "Content-Type: text/plain; charset=utf-8", "MIME-Version: 1.0", "", body].join("\n");
  return Buffer.from(msg).toString("base64url");
}

// Save email classifications to Supabase
async function saveEmailBatch(emails) {
  for (const e of emails) {
    try {
      // Check if already exists
      const check = await axios.get(
        `${SUPABASE_URL}/rest/v1/email_inbox?gmail_id=eq.${e.gmail_id}&select=id,status`,
        { headers: SUPA_HEADERS }
      );
      const existing = check.data && check.data[0];
      
      if (existing) {
        // Only update if still pending (don't overwrite approved/skipped)
        if (existing.status === 'pending') {
          await axios.patch(
            `${SUPABASE_URL}/rest/v1/email_inbox?gmail_id=eq.${e.gmail_id}`,
            { classification: e.classification, action: e.action, draft_reply: e.draft_reply, ai_reason: e.ai_reason },
            { headers: SUPA_HEADERS }
          );
        }
      } else {
        // Insert new
        await axios.post(`${SUPABASE_URL}/rest/v1/email_inbox`, e, { headers: SUPA_HEADERS });
      }
    } catch(err) {
      console.error("Error guardando email:", err.message);
    }
  }
}

async function getEmailBatch(status = "pending") {
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/email_inbox?status=eq.${status}&order=date.desc&limit=100`, { headers: SUPA_HEADERS });
  return r.data || [];
}

async function updateEmail(gmailId, updates) {
  await axios.patch(`${SUPABASE_URL}/rest/v1/email_inbox?gmail_id=eq.${gmailId}`, updates, { headers: SUPA_HEADERS });
}

loadGmailTokens();

module.exports = {
  getGmailAuthUrl, saveGmailTokens, getGmail,
  fetchNewEmails, archiveEmail, markAsSpam, deleteEmail, createDraft, applyLabel,
  starEmail, labelPrioritario, getEmailBody, sendEmail,
  saveEmailBatch, getEmailBatch, updateEmail,
  isConnected: () => !!gmailTokens
};
