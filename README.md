# 🤖 Tobin To-Do Bot

Bot de Telegram que gestiona tu to-do list usando Claude como agente.

## Deploy en Railway

### 1. Sube el código a GitHub
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/TU_USUARIO/tobin-bot.git
git push -u origin main
```

### 2. Crea proyecto en Railway
1. Ve a [railway.app](https://railway.app) e inicia sesión con GitHub
2. Clic en **"New Project"** → **"Deploy from GitHub repo"**
3. Selecciona el repositorio `tobin-bot`

### 3. Agrega variables de entorno en Railway
En tu proyecto Railway → **Variables** → agrega:

| Variable | Valor |
|----------|-------|
| `TELEGRAM_TOKEN` | `8785304220:AAGeQlc77pm5Eh5MwtpzpivrAkATT9_tpUA` |
| `ANTHROPIC_KEY` | `sk-ant-api03-hpmpnXbtr-...` |

### 4. Obtén tu URL de Railway
En Railway → tu proyecto → **Settings** → **Domains** → genera un dominio público.
Será algo como: `https://tobin-bot-production.up.railway.app`

### 5. Registra el webhook (una sola vez)
```bash
bash setup-webhook.sh https://tobin-bot-production.up.railway.app
```

O manualmente en el navegador:
```
https://api.telegram.org/bot8785304220:AAGeQlc77pm5Eh5MwtpzpivrAkATT9_tpUA/setWebhook?url=https://TU-URL.railway.app/webhook
```

## ✅ Listo — Habla con tu bot en @tobin77_bot

### Ejemplos de uso:
- *"Agrégame llamar a Santiago mañana, urgencia alta"*
- *"¿Qué tengo pendiente?"*
- *"Marca como listo el task #3"*
- *"Crea una tarea de $500 en 3 cuotas"*
- *"¿Cuánto debo en cuotas?"*
- *"Muéstrame todo"*
