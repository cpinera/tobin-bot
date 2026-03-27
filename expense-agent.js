const Anthropic = require('@anthropic-ai/sdk');
const { createExpenseRecord, getUSDtoCLP, MESES } = require('./airtable-expense');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

async function processExpense(fileBuffer, mimeType, fileName, telegramDate) {
  const usdRate = await getUSDtoCLP();
  const sentDate = new Date(telegramDate * 1000);

  const isImage = mimeType.startsWith('image/');

  const mediaContent = isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBuffer.toString('base64') } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } };

  const prompt = `Analiza este comprobante de gasto y extrae la informacion relevante.

Contexto:
- Fecha en que me enviaron el archivo: ${sentDate.toISOString().split('T')[0]}
- Tipo de cambio USD a CLP hoy (Banco Central Chile): ${usdRate}

Instrucciones:
- "item": nombre descriptivo del gasto (interpreta si es ambiguo, ej: "Almuerzo equipo", "MacBook Pro 14", "Articulos oficina Jumbo")
- "fechaGasto": fecha en que se realizo el gasto segun el documento (formato YYYY-MM-DD). Si no aparece en el documento, usa la fecha de envio.
- "totalCLP": monto total en pesos chilenos como numero entero. Si el documento esta en USD, convierte usando ${usdRate}.
- "monedaOriginal": "CLP" o "USD"
- "totalOriginal": monto original antes de conversion (igual a totalCLP si ya era CLP)

IMPORTANTE: Responde UNICAMENTE con JSON valido. Sin markdown, sin comillas triples, sin texto adicional. Solo el objeto JSON:
{"item":"...","fechaGasto":"YYYY-MM-DD","totalCLP":0,"monedaOriginal":"CLP","totalOriginal":0}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [mediaContent, { type: 'text', text: prompt }]
    }]
  });

  // Limpiar posibles markdown fences que Claude pueda agregar
  let rawText = response.content[0].text.trim();
  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const extracted = JSON.parse(rawText);

  const gastoDate = new Date(extracted.fechaGasto + 'T12:00:00');
  const mes = MESES[gastoDate.getMonth() + 1];
  const anio = gastoDate.getFullYear();

  const recordId = await createExpenseRecord({
    item: extracted.item,
    mes,
    fechaGasto: extracted.fechaGasto,
    anio,
    totalCLP: Math.round(extracted.totalCLP),
    fileBuffer,
    fileName,
    mimeType,
  });

  return {
    recordId,
    item: extracted.item,
    mes,
    fechaGasto: extracted.fechaGasto,
    anio,
    totalCLP: Math.round(extracted.totalCLP),
    monedaOriginal: extracted.monedaOriginal,
    totalOriginal: extracted.totalOriginal,
    usdRate: extracted.monedaOriginal === 'USD' ? usdRate : null,
  };
}

module.exports = { processExpense };
