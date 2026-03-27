const Anthropic = require('@anthropic-ai/sdk');
const { createExpenseRecord, convertToCLP, MESES } = require('./airtable-expense');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

async function processExpense(fileBuffer, mimeType, fileName, telegramDate) {
  const sentDate = new Date(telegramDate * 1000);

  const isImage = mimeType.startsWith('image/');

  const mediaContent = isImage
    ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: fileBuffer.toString('base64') } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } };

  const prompt = `Analiza este comprobante de gasto y extrae la informacion relevante.

Fecha en que me enviaron el archivo: ${sentDate.toISOString().split('T')[0]}

Instrucciones:
- "item": nombre descriptivo del gasto (ej: "Almuerzo equipo", "MacBook Pro 14", "Articulos oficina Jumbo")
- "fechaGasto": fecha en que se realizo el gasto segun el documento (YYYY-MM-DD). Si no aparece, usa la fecha de envio.
- "totalOriginal": monto total como numero (sin simbolos de moneda, sin puntos ni comas de miles)
- "moneda": codigo ISO de la moneda (CLP, USD, BRL, EUR, ARS, etc). Detecta la moneda del documento.

IMPORTANTE: Responde UNICAMENTE con JSON valido, sin markdown, sin texto adicional:
{"item":"...","fechaGasto":"YYYY-MM-DD","totalOriginal":0,"moneda":"CLP"}`;

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [mediaContent, { type: 'text', text: prompt }]
    }]
  });

  // Limpiar posibles markdown fences
  let rawText = response.content[0].text.trim();
  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const extracted = JSON.parse(rawText);

  // Convertir a CLP si es necesario
  let totalCLP = extracted.totalOriginal;
  let conversionRate = null;

  if (extracted.moneda !== 'CLP') {
    const conv = await convertToCLP(extracted.totalOriginal, extracted.moneda);
    totalCLP = conv.clp;
    conversionRate = conv.rate;
  }

  const gastoDate = new Date(extracted.fechaGasto + 'T12:00:00');
  const mes = MESES[gastoDate.getMonth() + 1];
  const anio = gastoDate.getFullYear();

  const recordId = await createExpenseRecord({
    item: extracted.item,
    mes,
    fechaGasto: extracted.fechaGasto,
    anio,
    totalCLP: Math.round(totalCLP),
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
    totalCLP: Math.round(totalCLP),
    moneda: extracted.moneda,
    totalOriginal: extracted.totalOriginal,
    conversionRate,
  };
}

module.exports = { processExpense };
