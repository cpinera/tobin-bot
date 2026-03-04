#!/bin/bash
# Ejecuta este script UNA VEZ después de deployar en Railway
# para registrar el webhook de Telegram

TELEGRAM_TOKEN="8785304220:AAGeQlc77pm5Eh5MwtpzpivrAkATT9_tpUA"
RAILWAY_URL="$1"  # Pasa tu URL de Railway como argumento

if [ -z "$RAILWAY_URL" ]; then
  echo "Uso: bash setup-webhook.sh https://tu-app.railway.app"
  exit 1
fi

echo "Registrando webhook en Telegram..."
curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${RAILWAY_URL}/webhook"
echo ""
echo "✅ Listo. Tu bot está conectado."
