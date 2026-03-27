const Airtable = require('airtable');
const fetch = require('node-fetch');
const FormData = require('form-data');

const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN })
  .base(process.env.AIRTABLE_BASE_ID);

const TABLE = 'Rend. CPM';

const MESES = {
  1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril',
  5: 'Mayo', 6: 'Junio', 7: 'Julio', 8: 'Agosto',
  9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre'
};

// Convierte cualquier moneda a CLP usando exchangerate-api
async function convertToCLP(amount, fromCurrency) {
  if (fromCurrency === 'CLP') return amount;
  try {
    // Primero intenta mindicador.cl para USD (más preciso para Chile)
    if (fromCurrency === 'USD') {
      const res = await fetch('https://mindicador.cl/api/dolar');
      const data = await res.json();
      const rate = data.serie[0].valor;
      return { clp: Math.round(amount * rate), rate };
    }
    // Para otras monedas usa exchangerate-api: convierte moneda → USD → CLP
    const [rateRes, usdRes] = await Promise.all([
      fetch(`https://api.exchangerate-api.com/v4/latest/${fromCurrency}`),
      fetch('https://mindicador.cl/api/dolar')
    ]);
    const rateData = await rateRes.json();
    const usdData = await usdRes.json();
    const toUSD = rateData.rates.USD;
    const usdToCLP = usdData.serie[0].valor;
    const rate = toUSD * usdToCLP;
    return { clp: Math.round(amount * rate), rate };
  } catch {
    // Fallback: exchangerate-api directo a CLP
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${fromCurrency}`);
    const data = await res.json();
    const rate = data.rates.CLP;
    return { clp: Math.round(amount * rate), rate };
  }
}

async function uploadFileToPublicUrl(buffer, fileName, mimeType) {
  const form = new FormData();
  form.append('file', buffer, { filename: fileName, contentType: mimeType });

  const res = await fetch('https://tmpfiles.org/api/v1/upload', {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  if (!res.ok) throw new Error('No se pudo subir el archivo a tmpfiles.org');

  const data = await res.json();
  return data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

async function createExpenseRecord({ item, mes, fechaGasto, anio, totalCLP, fileBuffer, fileName, mimeType }) {
  const fields = {
    'Item': item,
    'MES': mes,
    'Fecha del Gasto': fechaGasto,   // string "YYYY-MM-DD"
    'Año': String(anio),             // ← string, no número
    'TOTAL': totalCLP,               // número
  };

  if (fileBuffer) {
    const url = await uploadFileToPublicUrl(fileBuffer, fileName, mimeType);
    fields['RESPALDO BOLETAS Y FACTURAS'] = [{ url, filename: fileName }];
  }

  const record = await base(TABLE).create(fields);
  return record.getId();
}

module.exports = { createExpenseRecord, convertToCLP, MESES };
