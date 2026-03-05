const { google } = require("googleapis");

const GCAL_CLIENT_ID     = process.env.GCAL_CLIENT_ID;
const GCAL_CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
const GCAL_REDIRECT_URI  = "https://tobin-bot-production.up.railway.app/oauth/callback";

let gcalTokens = null;

function getOAuth2Client() {
  const oauth2 = new google.auth.OAuth2(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REDIRECT_URI);
  if (gcalTokens) oauth2.setCredentials(gcalTokens);
  return oauth2;
}

async function getCalendar() {
  if (!gcalTokens) throw new Error("Google Calendar no conectado. Autoriza en: https://tobin-bot-production.up.railway.app/oauth/start");
  const oauth2 = getOAuth2Client();
  return google.calendar({ version: "v3", auth: oauth2 });
}

async function listEvents(days = 1) {
  const cal = await getCalendar();
  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    timeZone: "America/Santiago"
  });
  return res.data.items || [];
}

async function createEvent(summary, startDateTime, endDateTime, description) {
  const cal = await getCalendar();
  const res = await cal.events.insert({
    calendarId: "primary",
    resource: {
      summary,
      description: description || "",
      start: { dateTime: startDateTime, timeZone: "America/Santiago" },
      end:   { dateTime: endDateTime,   timeZone: "America/Santiago" }
    }
  });
  return res.data;
}

async function deleteEvent(eventId) {
  const cal = await getCalendar();
  await cal.events.delete({ calendarId: "primary", eventId });
}

const CALENDAR_TOOLS = [
  {
    name: "list_events",
    description: "Lista eventos del calendario. days=1 para hoy, days=7 para esta semana.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer" } }
    }
  },
  {
    name: "create_event",
    description: "Crea un evento en Google Calendar. Fechas en ISO 8601 con timezone Chile, ej: 2026-03-05T14:00:00-03:00",
    input_schema: {
      type: "object",
      properties: {
        summary:       { type: "string" },
        startDateTime: { type: "string" },
        endDateTime:   { type: "string" },
        description:   { type: "string" }
      },
      required: ["summary", "startDateTime", "endDateTime"]
    }
  },
  {
    name: "delete_event",
    description: "Elimina un evento del calendario por su ID.",
    input_schema: {
      type: "object",
      properties: { eventId: { type: "string" } },
      required: ["eventId"]
    }
  }
];

async function executeCalendarTool(name, input) {
  if (name === "list_events") {
    const events = await listEvents(input.days || 1);
    if (!events.length) return { ok: true, message: "No hay eventos próximos.", events: [] };
    return { ok: true, events: events.map(e => ({
      id:      e.id,
      summary: e.summary,
      start:   e.start.dateTime || e.start.date,
      end:     e.end.dateTime   || e.end.date,
      location: e.location || ""
    })), total: events.length };
  }
  if (name === "create_event") {
    const event = await createEvent(input.summary, input.startDateTime, input.endDateTime, input.description);
    return { ok: true, event, message: "Evento creado: " + input.summary };
  }
  if (name === "delete_event") {
    await deleteEvent(input.eventId);
    return { ok: true, message: "Evento eliminado." };
  }
  return { ok: false, message: "Tool desconocida" };
}

module.exports = { CALENDAR_TOOLS, executeCalendarTool, getOAuth2Client, gcalTokens: () => gcalTokens, setTokens: (t) => { gcalTokens = t; } };
