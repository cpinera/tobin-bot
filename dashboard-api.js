// dashboard-api.js
// ════════════════════════════════════════════════════════════════
// Endpoints REST que consume tobin-dashboard.
//
// CÓMO INSTALAR:
// 1. Subir este archivo a la raíz del repo tobin-bot (al lado de index.js).
// 2. En index.js, justo ANTES de la línea `app.listen(...)` del final, agregar:
//
//      const { registerDashboardRoutes } = require('./dashboard-api');
//      registerDashboardRoutes(app, { auth, SUPABASE_URL, SUPABASE_KEY });
//
// 3. Commit y push. Railway lo redespliega solo.
//
// Todas las rutas están bajo el prefix /dashboard/ para no chocar
// con las rutas existentes de tobin-bot.
// ════════════════════════════════════════════════════════════════

const axios = require('axios');
const { executeCalendarTool } = require('./calendar');

function registerDashboardRoutes(app, deps) {
  const { auth, SUPABASE_URL, SUPABASE_KEY } = deps;

  const SUPA_HEADERS = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  const SUPA_UPSERT = {
    ...SUPA_HEADERS,
    Prefer: 'resolution=merge-duplicates,return=representation',
  };

  function logSupaErr(label, e) {
    console.error(`[dashboard] ${label}:`, e.message);
    if (e.response) {
      console.error(`[dashboard] ${label} status:`, e.response.status);
      console.error(`[dashboard] ${label} data:`, JSON.stringify(e.response.data));
    }
  }

  // ── Helpers ─────────────────────────────────────────────
  function todayChile() {
    // YYYY-MM-DD en zona Chile (maneja DST correctamente)
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
  function timeHHMM(iso) {
    if (!iso || !iso.includes('T')) return '';
    return iso.split('T')[1].slice(0, 5);
  }
  function isoDateOf(iso) {
    if (!iso) return '';
    return iso.slice(0, 10);
  }

  // ──────────────────────────────────────────────────────────
  //  Calendar
  // ──────────────────────────────────────────────────────────

  app.get('/dashboard/calendar/today', auth, async (req, res) => {
    try {
      const result = await executeCalendarTool('list_events', { days: 1 });
      if (!result.ok) return res.status(500).json({ error: result.message || 'Error al listar eventos' });
      const today = todayChile();
      const events = (result.events || []).filter(e => isoDateOf(e.start) === today);

      // Marcar hasNote consultando event_notes para los IDs visibles
      let hasNoteMap = {};
      if (events.length > 0) {
        const ids = events.map(e => `"${e.id.replace(/"/g, '')}"`).join(',');
        try {
          const notesRes = await axios.get(
            `${SUPABASE_URL}/rest/v1/event_notes?event_id=in.(${ids})&select=event_id,preparacion,durante`,
            { headers: SUPA_HEADERS }
          );
          (notesRes.data || []).forEach(n => {
            hasNoteMap[n.event_id] = !!((n.preparacion || '').trim() || (n.durante || '').trim());
          });
        } catch (e) {
          // si falla la consulta de notas, seguir sin marcar
          console.error('event_notes lookup failed:', e.message);
        }
      }

      const payload = events.map(e => ({
        id: e.id,
        start: timeHHMM(e.start),
        end: timeHHMM(e.end),
        title: e.summary || '(sin título)',
        hasNote: !!hasNoteMap[e.id],
      }));
      res.json(payload);
    } catch (e) {
      console.error('GET /dashboard/calendar/today error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/dashboard/calendar/event', auth, async (req, res) => {
    try {
      const { title, start, end, descripcion } = req.body || {};
      if (!title || !start || !end) {
        return res.status(400).json({ error: 'Faltan campos: title, start, end' });
      }
      const today = todayChile();
      // Determinar offset Chile actual (-04:00 o -03:00 según DST)
      const offsetMin = -new Date().getTimezoneOffset();
      const chileOffsetH = new Date().toLocaleString('en-US', { timeZone: 'America/Santiago', timeZoneName: 'longOffset' });
      // Forma simple: usar el offset que Intl reporta para Chile
      const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', timeZoneName: 'longOffset' });
      const parts = partsFmt.formatToParts(new Date());
      const tzName = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT-04:00';
      const offsetMatch = tzName.match(/([+-]\d{1,2}):?(\d{2})?/);
      const offset = offsetMatch ? `${offsetMatch[1].padStart(3, '+').replace('+-', '-')}:${offsetMatch[2] || '00'}` : '-04:00';
      const safeOffset = offset.startsWith('-') || offset.startsWith('+') ? offset : `-${offset}`;
      const startISO = `${today}T${start}:00${safeOffset}`;
      const endISO = `${today}T${end}:00${safeOffset}`;
      const result = await executeCalendarTool('create_event', {
        summary: title,
        startDateTime: startISO,
        endDateTime: endISO,
        description: descripcion || '',
      });
      if (!result.ok) return res.status(500).json({ error: result.message });
      res.json({ ok: true, id: result.event && result.event.id });
    } catch (e) {
      console.error('POST /dashboard/calendar/event error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  //  Tasks (top to-dos)
  // ──────────────────────────────────────────────────────────

  app.get('/dashboard/tasks', auth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 3;
      const offset = parseInt(req.query.offset, 10) || 0;
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/tasks?estado=eq.Pendiente&order=created_at.asc`,
        { headers: SUPA_HEADERS }
      );
      const orderUrg = { Alta: 0, Media: 1, Baja: 2 };
      const sorted = (r.data || []).sort((a, b) => {
        const ua = orderUrg[a.urgencia] ?? 99;
        const ub = orderUrg[b.urgencia] ?? 99;
        if (ua !== ub) return ua - ub;
        return new Date(a.created_at) - new Date(b.created_at);
      });
      const items = sorted.slice(offset, offset + limit).map(t => ({
        id: t.id,
        nombre: t.nombre,
        urgencia: t.urgencia,
        estado: t.estado,
      }));
      res.json({ items, total: sorted.length });
    } catch (e) {
      console.error('GET /dashboard/tasks error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/dashboard/tasks/:id', auth, async (req, res) => {
    try {
      const body = {};
      if (req.body.estado !== undefined) body.estado = req.body.estado;
      if (req.body.nombre !== undefined) body.nombre = req.body.nombre;
      if (req.body.urgencia !== undefined) body.urgencia = req.body.urgencia;
      const r = await axios.patch(
        `${SUPABASE_URL}/rest/v1/tasks?id=eq.${parseInt(req.params.id, 10)}`,
        body,
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true, task: (r.data || [])[0] });
    } catch (e) {
      console.error('PATCH /dashboard/tasks error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────
  //  Daily notes (panel "Notas del día")
  // ──────────────────────────────────────────────────────────

  app.get('/dashboard/daily-notes/:fecha', auth, async (req, res) => {
    try {
      const fecha = req.params.fecha;
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/daily_notes?fecha=eq.${fecha}`,
        { headers: SUPA_HEADERS }
      );
      if (r.data && r.data.length > 0) {
        const row = r.data[0];
        return res.json({ items: row.items || [], archive: row.archive || [] });
      }
      // Carryover desde el día anterior
      const yesterday = new Date(new Date(fecha + 'T12:00:00Z').getTime() - 86400000)
        .toISOString().slice(0, 10);
      let carry = [];
      try {
        const y = await axios.get(
          `${SUPABASE_URL}/rest/v1/daily_notes?fecha=eq.${yesterday}`,
          { headers: SUPA_HEADERS }
        );
        if (y.data && y.data.length > 0) {
          const yItems = y.data[0].items || [];
          carry = yItems.filter(it => !(it.tipo === 'check' && it.completado));
        }
      } catch (e) {
        logSupaErr('daily-notes carryover read', e);
      }
      // Insertar fila nueva con el carryover (con on_conflict explícito)
      try {
        await axios.post(
          `${SUPABASE_URL}/rest/v1/daily_notes?on_conflict=fecha`,
          { fecha, items: carry, archive: [] },
          { headers: SUPA_UPSERT }
        );
      } catch (e) {
        logSupaErr('daily-notes insert new row', e);
        // No fallar — devolvemos el carry aunque no se haya guardado.
        // El siguiente save (PUT desde el frontend) lo persistirá.
      }
      res.json({ items: carry, archive: [] });
    } catch (e) {
      logSupaErr('GET /dashboard/daily-notes', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  app.post('/dashboard/daily-notes/:fecha', auth, async (req, res) => {
    try {
      const fecha = req.params.fecha;
      const { items, archive } = req.body || {};
      await axios.post(
        `${SUPABASE_URL}/rest/v1/daily_notes?on_conflict=fecha`,
        {
          fecha,
          items: items || [],
          archive: archive || [],
          updated_at: new Date().toISOString(),
        },
        { headers: SUPA_UPSERT }
      );
      res.json({ ok: true });
    } catch (e) {
      logSupaErr('POST /dashboard/daily-notes', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // ──────────────────────────────────────────────────────────
  //  Event notes (notas asociadas a eventos del calendario)
  // ──────────────────────────────────────────────────────────

  app.get('/dashboard/event-notes/:event_id', auth, async (req, res) => {
    try {
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/event_notes?event_id=eq.${encodeURIComponent(req.params.event_id)}`,
        { headers: SUPA_HEADERS }
      );
      if (!r.data || r.data.length === 0) {
        return res.json({ prep: '', durante: '' });
      }
      const row = r.data[0];
      res.json({ prep: row.preparacion || '', durante: row.durante || '' });
    } catch (e) {
      console.error('GET /dashboard/event-notes error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Normaliza event_start: acepta "HH:MM" (lo combina con hoy en Chile) o ISO completo.
  // Devuelve string ISO válido o null.
  function normalizeEventStart(s) {
    if (!s || typeof s !== 'string') return null;
    if (/^\d{2}:\d{2}$/.test(s)) {
      // Solo hora; combinar con hoy en Chile
      const today = todayChile();
      // Chile es UTC-4 (o UTC-3 con DST). Detectamos el offset actual.
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Santiago', timeZoneName: 'longOffset',
      }).formatToParts(new Date());
      const tz = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT-04:00';
      const m = tz.match(/([+-]\d{1,2})(?::?(\d{2}))?/);
      const offset = m ? `${m[1].padStart(3, '+').replace('+-', '-')}:${m[2] || '00'}` : '-04:00';
      return `${today}T${s}:00${offset}`;
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  app.post('/dashboard/event-notes/:event_id', auth, async (req, res) => {
    try {
      const { prep, durante, event_title, event_start } = req.body || {};
      const normalizedStart = normalizeEventStart(event_start);
      await axios.post(
        `${SUPABASE_URL}/rest/v1/event_notes?on_conflict=event_id`,
        {
          event_id: req.params.event_id,
          event_title: event_title || null,
          event_start: normalizedStart,
          preparacion: prep || '',
          durante: durante || '',
          updated_at: new Date().toISOString(),
        },
        { headers: SUPA_UPSERT }
      );
      res.json({ ok: true });
    } catch (e) {
      logSupaErr('POST /dashboard/event-notes', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  app.delete('/dashboard/event-notes/:event_id', auth, async (req, res) => {
    try {
      await axios.delete(
        `${SUPABASE_URL}/rest/v1/event_notes?event_id=eq.${encodeURIComponent(req.params.event_id)}`,
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true });
    } catch (e) {
      logSupaErr('DELETE /dashboard/event-notes', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // ══════════════════════════════════════════════════════════
  // NUEVA ARQUITECTURA: note_items (una fila por nota individual)
  // ══════════════════════════════════════════════════════════

  // GET activas: no borradas, y (no completadas OR completadas hoy)
  app.get('/dashboard/note-items/active', auth, async (req, res) => {
    try {
      const today = todayChile();
      const startOfToday = `${today}T00:00:00-04:00`;
      const url = `${SUPABASE_URL}/rest/v1/note_items?deleted=eq.false&or=(completado.eq.false,completado_at.gte.${encodeURIComponent(startOfToday)})&order=creado_at.asc`;
      const r = await axios.get(url, { headers: SUPA_HEADERS });
      res.json(r.data || []);
    } catch (e) {
      logSupaErr('GET /dashboard/note-items/active', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Crear nueva nota
  app.post('/dashboard/note-items', auth, async (req, res) => {
    try {
      const { tipo, texto, titulo, cuerpo } = req.body || {};
      const r = await axios.post(
        `${SUPABASE_URL}/rest/v1/note_items`,
        {
          tipo: tipo || 'check',
          texto: texto || '',
          titulo: titulo || '',
          cuerpo: cuerpo || '',
          completado: false,
        },
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true, item: (r.data || [])[0] });
    } catch (e) {
      logSupaErr('POST /dashboard/note-items', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Editar / toggle / etc.
  app.patch('/dashboard/note-items/:id', auth, async (req, res) => {
    try {
      const body = {};
      const fields = ['tipo', 'texto', 'titulo', 'cuerpo'];
      fields.forEach(f => { if (req.body[f] !== undefined) body[f] = req.body[f]; });
      if (req.body.completado !== undefined) {
        body.completado = !!req.body.completado;
        body.completado_at = body.completado ? new Date().toISOString() : null;
      }
      body.updated_at = new Date().toISOString();
      const r = await axios.patch(
        `${SUPABASE_URL}/rest/v1/note_items?id=eq.${req.params.id}`,
        body,
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true, item: (r.data || [])[0] });
    } catch (e) {
      logSupaErr('PATCH /dashboard/note-items', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Borrar (soft delete)
  app.delete('/dashboard/note-items/:id', auth, async (req, res) => {
    try {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/note_items?id=eq.${req.params.id}`,
        { deleted: true, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true });
    } catch (e) {
      logSupaErr('DELETE /dashboard/note-items', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Historial: todas las notas (incluso completadas), no borradas, agrupadas por fecha de creación
  app.get('/dashboard/note-items/history', auth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 500;
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/note_items?deleted=eq.false&order=creado_at.desc&limit=${limit}`,
        { headers: SUPA_HEADERS }
      );
      res.json(r.data || []);
    } catch (e) {
      logSupaErr('GET /dashboard/note-items/history', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  app.get('/dashboard/daily-notes-list', auth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 60;
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/daily_notes?order=fecha.desc&limit=${limit}`,
        { headers: SUPA_HEADERS }
      );
      const items = (r.data || []).map(row => {
        const it = row.items || [];
        const ar = row.archive || [];
        const firstItem = it[0] || ar[0];
        const previewText = firstItem ? (firstItem.titulo || firstItem.texto || '(sin contenido)') : '(sin notas)';
        return {
          fecha: row.fecha,
          items_count: it.length,
          archive_count: ar.length,
          preview: String(previewText).slice(0, 120),
        };
      });
      res.json(items);
    } catch (e) {
      logSupaErr('GET /dashboard/daily-notes-list', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  app.get('/dashboard/event-notes', auth, async (req, res) => {
    try {
      const search = (req.query.search || '').trim();
      const limit = parseInt(req.query.limit, 10) || 50;
      let url = `${SUPABASE_URL}/rest/v1/event_notes?order=event_start.desc&limit=${limit}`;
      if (search) {
        const enc = encodeURIComponent(`%${search}%`);
        url += `&or=(event_title.ilike.${enc},preparacion.ilike.${enc},durante.ilike.${enc})`;
      }
      const r = await axios.get(url, { headers: SUPA_HEADERS });
      const items = (r.data || []).map(row => {
        const blob = ((row.preparacion || '') + ' · ' + (row.durante || ''))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        return {
          event_id: row.event_id,
          title: row.event_title || '(sin título)',
          date: (row.event_start || '').slice(0, 10),
          preview: blob,
        };
      });
      res.json(items);
    } catch (e) {
      console.error('GET /dashboard/event-notes (list) error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  //  Cuentas (checklist de pagos mensuales)
  //  - cuentas_items: ítem recurrente (nombre + monto default)
  //  - cuentas_mes:   estado por mes (pagado) con PK (item_id, mes)
  // ══════════════════════════════════════════════════════════

  // Lista los ítems activos + su estado de pagado para el mes dado.
  app.get('/dashboard/cuentas/:mes', auth, async (req, res) => {
    try {
      const mes = req.params.mes; // 'YYYY-MM'
      const itemsRes = await axios.get(
        `${SUPABASE_URL}/rest/v1/cuentas_items?deleted=eq.false&order=orden.asc,creado_at.asc`,
        { headers: SUPA_HEADERS }
      );
      const items = itemsRes.data || [];
      let estados = [];
      if (items.length > 0) {
        try {
          const est = await axios.get(
            `${SUPABASE_URL}/rest/v1/cuentas_mes?mes=eq.${encodeURIComponent(mes)}`,
            { headers: SUPA_HEADERS }
          );
          estados = est.data || [];
        } catch (e) {
          logSupaErr('cuentas_mes read', e);
        }
      }
      const estMap = {};
      estados.forEach(e => { estMap[e.item_id] = e; });
      const payload = items.map(it => ({
        id: it.id,
        nombre: it.nombre,
        monto: Number(it.monto) || 0,
        orden: it.orden || 0,
        pagado: !!(estMap[it.id] && estMap[it.id].pagado),
      }));
      res.json(payload);
    } catch (e) {
      logSupaErr('GET /dashboard/cuentas', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Crear ítem nuevo
  app.post('/dashboard/cuentas', auth, async (req, res) => {
    try {
      const { nombre, monto, orden } = req.body || {};
      const r = await axios.post(
        `${SUPABASE_URL}/rest/v1/cuentas_items`,
        { nombre: nombre || '', monto: Number(monto) || 0, orden: Number(orden) || 0 },
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true, item: (r.data || [])[0] });
    } catch (e) {
      logSupaErr('POST /dashboard/cuentas', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Editar ítem (nombre y/o monto default y/o orden)
  app.patch('/dashboard/cuentas/:id', auth, async (req, res) => {
    try {
      const body = {};
      if (req.body.nombre !== undefined) body.nombre = req.body.nombre;
      if (req.body.monto !== undefined) body.monto = Number(req.body.monto) || 0;
      if (req.body.orden !== undefined) body.orden = Number(req.body.orden) || 0;
      body.updated_at = new Date().toISOString();
      const r = await axios.patch(
        `${SUPABASE_URL}/rest/v1/cuentas_items?id=eq.${parseInt(req.params.id, 10)}`,
        body,
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true, item: (r.data || [])[0] });
    } catch (e) {
      logSupaErr('PATCH /dashboard/cuentas', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Borrar ítem (soft delete)
  app.delete('/dashboard/cuentas/:id', auth, async (req, res) => {
    try {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/cuentas_items?id=eq.${parseInt(req.params.id, 10)}`,
        { deleted: true, updated_at: new Date().toISOString() },
        { headers: SUPA_HEADERS }
      );
      res.json({ ok: true });
    } catch (e) {
      logSupaErr('DELETE /dashboard/cuentas', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  // Marcar/desmarcar pagado para un mes (upsert por item_id+mes)
  app.put('/dashboard/cuentas/:id/check/:mes', auth, async (req, res) => {
    try {
      const item_id = parseInt(req.params.id, 10);
      const mes = req.params.mes;
      const pagado = !!(req.body && req.body.pagado);
      await axios.post(
        `${SUPABASE_URL}/rest/v1/cuentas_mes?on_conflict=item_id,mes`,
        { item_id, mes, pagado, updated_at: new Date().toISOString() },
        { headers: SUPA_UPSERT }
      );
      res.json({ ok: true });
    } catch (e) {
      logSupaErr('PUT /dashboard/cuentas check', e);
      res.status(500).json({ error: e.message, detail: e.response?.data });
    }
  });

  console.log('✓ Dashboard routes registradas en /dashboard/*');
}

module.exports = { registerDashboardRoutes };
