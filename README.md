# Integración Airtable → Tobin Bot

## Archivos incluidos

| Archivo | Qué hace |
|---|---|
| `airtable-expense.js` | Conecta con Airtable y sube registros + archivos |
| `expense-agent.js` | Usa Claude para extraer datos de fotos/PDFs |
| `telegram-handlers.js` | Handlers de Telegram para fotos y documentos |

## Instalación

### 1. Copia los archivos al repo
Copia `airtable-expense.js` y `expense-agent.js` a la raíz del proyecto.

### 2. Pega los handlers en index.js
Abre `telegram-handlers.js` y pega su contenido en `index.js`:
- Los `require` al inicio del archivo
- Los handlers `bot.on('photo')` y `bot.on('document')` al final

### 3. Instala dependencias
```bash
npm install airtable node-fetch form-data
```

### 4. Agrega variables de entorno en Railway

| Variable | Cómo obtenerla |
|---|---|
| `AIRTABLE_TOKEN` | airtable.com/create/tokens → scope: data.records:write |
| `AIRTABLE_BASE_ID` | La URL de tu base: airtable.com/**appXXXXXXX**/... |

## Cómo funciona

1. Le mandas una foto o PDF al bot por Telegram
2. El bot descarga el archivo
3. Claude analiza el documento y extrae: item, fecha, total (convierte USD→CLP si aplica)
4. Se sube el archivo y se crea el registro en Airtable → Rend. CPM

## Nombre de columnas (deben coincidir exactamente)

- `Item`
- `MES`
- `Fecha del Gasto`
- `Año`
- `TOTAL`
- `RESPALDO BOLETA`
