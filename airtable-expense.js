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

async function getUSDtoCLP() {
  try {
    const res = await fetch('https://mindicador.cl/api/dolar');
    const data = await res.json();
    return data.serie[0].valor;
  } catch {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await res.json();
    return data.rates.CLP;
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
    'Fecha del Gasto': fechaGasto,
    'Año': anio,
    'TOTAL': totalCLP,
  };

  if (fileBuffer) {
    const url = await uploadFileToPublicUrl(fileBuffer, fileName, mimeType);
    fields['RESPALDO BOLETA'] = [{ url, filename: fileName }];
  }

  const record = await base(TABLE).create(fields);
  return record.getId();
}

module.exports = { createExpenseRecord, getUSDtoCLP, MESES };
