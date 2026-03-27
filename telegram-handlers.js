// ─────────────────────────────────────────────────────────────
// Pega este contenido dentro de index.js, después de tus
// handlers existentes. También agrega los requires al inicio.
// ─────────────────────────────────────────────────────────────

// AGREGAR AL INICIO DE index.js (si no están ya):
// const fetch = require('node-fetch');
// const { processExpense } = require('./expense-agent');

// ─── Helper: descarga archivo desde Telegram ─────────────────
async function downloadTelegramFile(ctx, fileId) {
  const fileInfo = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo descargar el archivo de Telegram');
  return Buffer.from(await res.arrayBuffer());
}

// ─── Helper: arma el mensaje de respuesta ────────────────────
function buildReplyMessage(result) {
  let msg = `✅ *Gasto registrado en Airtable*\n\n`;
  msg += `📌 *Item:* ${result.item}\n`;
  msg += `📅 *Fecha del gasto:* ${result.fechaGasto}\n`;
  msg += `🗓 *Mes:* ${result.mes} ${result.anio}\n`;
  msg += `💰 *Total:* $${result.totalCLP.toLocaleString('es-CL')} CLP`;

  if (result.monedaOriginal === 'USD') {
    msg += `\n   _($${result.totalOriginal} USD × $${Math.round(result.usdRate).toLocaleString('es-CL')} = CLP)_`;
  }

  msg += `\n📎 *Respaldo:* imagen subida`;
  return msg;
}

// ─── Handler: foto enviada directamente ──────────────────────
bot.on('photo', async (ctx) => {
  const processing = await ctx.reply('⏳ Procesando boleta...');
  try {
    const photo = ctx.message.photo.at(-1); // mayor resolución
    const buffer = await downloadTelegramFile(ctx, photo.file_id);
    const result = await processExpense(buffer, 'image/jpeg', `boleta_${Date.now()}.jpg`, ctx.message.date);
    await ctx.telegram.editMessageText(
      ctx.chat.id, processing.message_id, null,
      buildReplyMessage(result), { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error procesando foto:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, null, `❌ Error: ${err.message}`);
  }
});

// ─── Handler: documento (PDF o imagen como archivo) ──────────
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const accepted = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/webp'];

  if (!accepted.includes(doc.mime_type)) {
    return ctx.reply('⚠️ Solo acepto fotos o PDFs para registrar gastos en Airtable.');
  }

  const processing = await ctx.reply('⏳ Procesando documento...');
  try {
    const buffer = await downloadTelegramFile(ctx, doc.file_id);
    const fileName = doc.file_name || `doc_${Date.now()}`;
    const result = await processExpense(buffer, doc.mime_type, fileName, ctx.message.date);
    await ctx.telegram.editMessageText(
      ctx.chat.id, processing.message_id, null,
      buildReplyMessage(result), { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error procesando documento:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, processing.message_id, null, `❌ Error: ${err.message}`);
  }
});
