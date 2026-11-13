# WG Multimarcas — Loja
Variáveis de ambiente (Render): DATABASE_URL (Neon), JWT_SECRET (texto longo), ADMIN_PASSWORD, WHATSAPP (ex: 5516999999999), PIX_KEY.
Comando de build: `npm install` · Start: `npm start` · Testes: `npm test`.
Loja: /loja.html · Painel: /admin.html

## Variáveis (Render > Environment)
DATABASE_URL (Neon), JWT_SECRET (24+ caracteres), ADMIN_PASSWORD (forte), WHATSAPP, PIX_KEY,
CORS_ORIGIN (ex.: https://trulusiolotreck.github.io) — o servidor NÃO inicia sem JWT_SECRET e ADMIN_PASSWORD.
Frontend no GitHub Pages: edite public/config.js com a URL do Render.

Pagamento online com Mercado Pago Checkout Pro está em modo de teste e só liga com as variáveis do servidor. O guia, os nomes das variáveis e o que falta para produção estão em [docs/mercado-pago.md](docs/mercado-pago.md). Não coloque token nem segredo no Git. Sem essas variáveis, a vitrine e o WhatsApp continuam funcionando.
