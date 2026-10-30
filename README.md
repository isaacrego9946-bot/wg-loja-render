# WG Multimarcas — Loja
Variáveis de ambiente (Render): DATABASE_URL (Neon), JWT_SECRET (texto longo), ADMIN_PASSWORD, WHATSAPP (ex: 5516999999999), PIX_KEY.
Comando de build: `npm install` · Start: `npm start`.
Loja: /loja.html · Painel: /admin.html

## Variáveis (Render > Environment)
DATABASE_URL (Neon), JWT_SECRET (24+ caracteres), ADMIN_PASSWORD (forte), WHATSAPP, PIX_KEY,
CORS_ORIGIN (ex.: https://trulusiolotreck.github.io) — o servidor NÃO inicia sem JWT_SECRET e ADMIN_PASSWORD.
Frontend no GitHub Pages: edite public/config.js com a URL do Render.
