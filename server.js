const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { frete, createOrder } = require('./lib/orders');
const { readConfig, createClient } = require('./lib/mp');
const { attachPreference, syncOrder, handleWebhook, canAccess, publicOrder } = require('./lib/payments');
const { createPgStore } = require('./lib/pg-store');

const SCHEMA = `
create table if not exists products(id serial primary key,name text,category text,price numeric(10,2),image text,description text);
create table if not exists variants(id serial primary key,product_id int references products(id) on delete cascade,size text,color text,stock int default 0);
create table if not exists users(id serial primary key,name text,email text unique,phone text,pass text);
create table if not exists orders(id serial primary key,user_id int,customer jsonb,items jsonb,shipping numeric(10,2),total numeric(10,2),payment text,status text default 'Novo',created_at timestamptz default now());
alter table orders add column if not exists request_key text;
alter table orders add column if not exists request_hash text;
alter table orders add column if not exists mp_preference_id text;
alter table orders add column if not exists mp_checkout_url text;
alter table orders add column if not exists mp_collector_id text;
alter table orders add column if not exists mp_idempotency_key text;
alter table orders add column if not exists mp_status text;
alter table orders add column if not exists mp_payment_id text;
alter table orders add column if not exists mp_installments int;
alter table orders add column if not exists mp_payment_method text;
alter table orders add column if not exists stock_restored boolean default false;
create unique index if not exists order_request_key on orders(user_id,request_key);
create unique index if not exists orders_mp_preference on orders(mp_preference_id) where mp_preference_id is not null;
create unique index if not exists orders_mp_idempotency on orders(mp_idempotency_key) where mp_idempotency_key is not null;
create table if not exists mp_notifications(request_id text primary key,data_id text not null,ts text not null,received_at timestamptz default now());
create table if not exists mp_payments(payment_id text primary key,order_id int not null,status text not null,amount_cents int not null,currency text not null,live_mode boolean not null,installments int,payment_method text,payment_type text,accepted boolean not null default false,updated_at timestamptz default now());
`;
const ORDER_STATUSES = ['Novo', 'Pendente', 'Pago', 'Recusado', 'Cancelado', 'Reembolsado', 'Contestado', 'Parcialmente reembolsado', 'Separando', 'Enviado', 'Entregue'];

function createApp(options = {}) {
  const env = options.env || process.env;
  if (!env.JWT_SECRET || !env.ADMIN_PASSWORD || String(env.JWT_SECRET).length < 24) {
    throw new Error('Defina JWT_SECRET (24+ caracteres) e ADMIN_PASSWORD no ambiente.');
  }
  const app = express();
  app.set('trust proxy', 1);
  const origins = (env.CORS_ORIGIN || 'https://trulusiolotreck.github.io').split(',');
  app.use((q, r, n) => {
    const origin = q.headers.origin;
    if (origin && origins.includes(origin)) r.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', Vary: 'Origin' });
    if (q.method === 'OPTIONS') return r.sendStatus(204);
    n();
  });
  const tries = {};
  app.use(['/api/admin/login', '/api/login'], (q, r, n) => {
    if (q.method !== 'POST') return n();
    const now = Date.now();
    const attempts = (tries[q.ip] = (tries[q.ip] || []).filter(time => now - time < 9e5));
    if (attempts.length >= 10) return r.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
    attempts.push(now);
    n();
  });
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static('public'));
  app.get('/health', (q, r) => r.send('ok'));
  const db = options.db || new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  if (typeof db.on === 'function') db.on('error', error => console.error('db', error.message));
  const store = options.store || createPgStore(db);
  if (!options.store) db.query(SCHEMA).catch(error => console.error('Banco indisponível:', error.message));
  const SECRET = env.JWT_SECRET;
  const ADMIN = env.ADMIN_PASSWORD;
  const WA = env.WHATSAPP || '5516988166427';
  const mpConfig = readConfig(env);
  const mp = createClient(mpConfig, options.fetchImpl);
  if (!mpConfig.enabled) console.error('Mercado Pago desligado (%s). Catálogo e pedidos por WhatsApp seguem disponíveis.', mpConfig.reason);
  else console.error('Mercado Pago ativo em modo %s.', mpConfig.mode === 'production' ? 'producao' : 'teste');
  const auth = (req, res, next) => { try { req.u = jwt.verify((req.headers.authorization || '').slice(7), SECRET); if (!Number.isSafeInteger(req.u.id) || req.u.id <= 0) return res.status(401).json({ erro: 'Faça login' }); next(); } catch { res.status(401).json({ erro: 'Faça login' }); } };
  const adm = (req, res, next) => { try { if (jwt.verify((req.headers.authorization || '').slice(7), SECRET).admin) return next(); } catch { /* segue para a negação abaixo */ } res.status(401).json({ erro: 'Acesso negado' }); };
  const optionalAuth = (req, res, next) => {
    const header = req.headers.authorization || '';
    if (!header || header === 'Bearer' || header === 'Bearer ') return next();
    try { req.u = jwt.verify(header.slice(7), SECRET); next(); } catch { res.status(401).json({ erro: 'Sessão expirada. Saia da conta para comprar como visitante.' }); }
  };
  const W = fn => (q, r, n) => Promise.resolve(fn(q, r, n)).catch(error => { console.error('api', error.code || 'falha'); r.status(500).json({ erro: 'Não foi possível concluir. Tente novamente.' }); });
  const insightsReady = require('./insights')(app, db, adm);
  app.get('/api/config', (q, r) => r.json({ whatsapp: WA, pix: env.PIX_KEY || '', mercadopago: { ativo: mpConfig.enabled, modo: mpConfig.enabled ? (mpConfig.mode === 'production' ? 'producao' : 'teste') : null } }));
  app.get('/api/frete/:cep', (q, r) => r.json(frete(q.params.cep)));
  app.get('/api/products', W(async (q, r) => {
    const { q: term = '', cat = '', size = '', color = '' } = q.query;
    const products = await db.query(`select p.*,coalesce(json_agg(json_build_object('id',v.id,'size',v.size,'color',v.color,'stock',v.stock)) filter(where v.id is not null),'[]') variants from products p left join variants v on v.product_id=p.id where p.name ilike $1 and ($2='' or p.category=$2) group by p.id order by p.id desc`, [`%${term}%`, cat]);
    r.json(products.rows.filter(product => (!size && !color) || product.variants.some(variant => (!size || variant.size === size) && (!color || variant.color === color))));
  }));
  app.post('/api/register', (q, r) => r.status(403).json({ erro: 'Cadastro indisponível' }));
  app.post('/api/login', W(async (q, r) => {
    const name = env.STORE_LOGIN_NAME;
    if (!name || q.body.name !== name || q.body.password !== ADMIN) return r.status(401).json({ erro: 'Nome ou senha inválidos' });
    const user = (await db.query("insert into users(name,email,pass) values($1,$2,$3) on conflict(email) do update set name=excluded.name returning id,name", [name, 'store-access@wg.invalid', await bcrypt.hash(ADMIN, 10)])).rows[0];
    r.json({ token: jwt.sign({ id: user.id, name: user.name }, SECRET, { expiresIn: '30d' }), name: user.name });
  }));
  const checkoutAuth = (q, r, n) => {
    if (q.headers.authorization && q.headers.authorization !== 'Bearer' && q.headers.authorization !== 'Bearer ') {
      try { q.u = jwt.verify(q.headers.authorization.slice(7), SECRET); if (!Number.isSafeInteger(q.u.id) || q.u.id <= 0) return r.status(401).json({ erro: 'Entre novamente na conta.' }); return n(); } catch { return r.status(401).json({ erro: 'Sessão expirada. Saia da conta para comprar como visitante.' }); }
    }
    const name = String(q.body?.customer_name || '').trim();
    const phone = String(q.body?.phone || '').replace(/\D/g, '');
    if (name.length < 2 || name.length > 100 || !/^\d{10,13}$/.test(phone)) return r.status(400).json({ erro: 'Informe seu nome e telefone com DDD.' });
    if (!['entrega', 'retirada'].includes(q.body?.delivery) || !['pix', 'cartao'].includes(q.body?.payment)) return r.status(400).json({ erro: 'Escolha entrega e pagamento.' });
    if (q.body.delivery === 'entrega' && (String(q.body.address || '').trim().length < 5 || String(q.body.cep || '').replace(/\D/g, '').length !== 8)) return r.status(400).json({ erro: 'Informe o endereço completo e um CEP com 8 dígitos.' });
    q.u = { id: 0, name };
    n();
  };
  async function withCheckout(order) {
    if (!mpConfig.enabled) return { order, aviso: null };
    try { return { order: await attachPreference(store, mp, order.id), aviso: null }; }
    catch (error) {
      console.error('mp preferencia', error.mpStatus || 'falha');
      return { order, aviso: 'Não foi possível abrir o Mercado Pago. O pedido foi registrado e o WhatsApp continua disponível.' };
    }
  }
  app.post('/api/orders', checkoutAuth, W(async (q, r) => {
    try {
      const order = await createOrder(store, { user: q.u, body: q.body });
      const paid = await withCheckout(order);
      const payload = publicOrder(paid.order, { checkout: true });
      payload.mercadopago = mpConfig.enabled;
      if (paid.aviso) payload.aviso = paid.aviso;
      r.json(payload);
    } catch (error) {
      if (!error.expose) console.error('pedido', error.code || 'falha');
      r.status(error.expose ? error.status || 400 : 400).json({ erro: error.expose ? error.message : 'Não foi possível concluir o pedido.' });
    }
  }));
  async function ownedOrder(q, r) {
    const id = Number(q.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const order = await store.findOrder(id);
    if (!canAccess(order, { user: q.u, requestKey: q.body?.request_key })) {
      r.status(404).json({ erro: 'Pedido não encontrado.' });
      return null;
    }
    return order;
  }
  app.post('/api/orders/:id/checkout', optionalAuth, W(async (q, r) => {
    const order = await ownedOrder(q, r);
    if (!order) return;
    const paid = await withCheckout(order);
    const payload = publicOrder(paid.order, { checkout: true });
    if (paid.aviso) payload.aviso = paid.aviso;
    r.json(payload);
  }));
  app.post('/api/orders/:id/sync', optionalAuth, W(async (q, r) => {
    const order = await ownedOrder(q, r);
    if (!order) return;
    try { r.json(publicOrder(await syncOrder(store, mp, order.id), { checkout: true })); }
    catch (error) { console.error('mp sync', error.mpStatus || 'falha'); r.status(503).json({ erro: 'Não foi possível consultar o pagamento.' }); }
  }));
  app.post('/api/payments/webhook', async (q, r) => {
    const result = await handleWebhook(store, mp, { query: q.query, headers: q.headers, body: q.body || {} });
    r.status(result.status).json(result.body);
  });
  app.get('/api/orders/mine', auth, W(async (q, r) => r.json((await store.listMine(q.u.id)).map(order => publicOrder(order, { checkout: true })))));
  app.post('/api/admin/login', (q, r) => q.body.password === ADMIN ? r.json({ token: jwt.sign({ admin: 1 }, SECRET, { expiresIn: '12h' }) }) : r.status(401).json({ erro: 'Senha incorreta' }));
  app.post('/api/admin/products', adm, W(async (q, r) => {
    const { id, name, category, price, image, description, variants = [] } = q.body;
    if (typeof name !== 'string' || !name.trim() || price === '' || price == null || !Number.isFinite(+price) || +price < 0 || !Array.isArray(variants) || variants.some(v => !v || typeof v.size !== 'string' || !v.size.trim() || typeof v.color !== 'string' || !v.color.trim() || !Number.isSafeInteger(v.stock) || v.stock < 0)) return r.status(400).json({ erro: 'Informe nome, preço válido e estoque inteiro maior ou igual a zero.' });
    const keys = variants.map(v => JSON.stringify([v.size.trim(), v.color.trim()]));
    if (new Set(keys).size !== keys.length) return r.status(400).json({ erro: 'Não repita a mesma combinação de tamanho e cor.' });
    const c = await db.connect();
    try {
      await c.query('begin');
      let pid = id;
      if (id) { const updated = await c.query('update products set name=$1,category=$2,price=$3,image=$4,description=$5 where id=$6 returning id', [name.trim(), category, price, image, description, id]); if (!updated.rows.length) throw Error('Produto não encontrado'); }
      else pid = (await c.query('insert into products(name,category,price,image,description) values($1,$2,$3,$4,$5) returning id', [name.trim(), category, price, image, description])).rows[0].id;
      const previous = (await c.query('select * from variants where product_id=$1 for update', [pid])).rows;
      const keep = [];
      for (const v of variants) {
        const size = v.size.trim();
        const color = v.color.trim();
        const old = previous.find(x => x.size === size && x.color === color);
        if (old) { await c.query('update variants set stock=$1 where id=$2', [v.stock, old.id]); keep.push(old.id); }
        else keep.push((await c.query('insert into variants(product_id,size,color,stock) values($1,$2,$3,$4) returning id', [pid, size, color, v.stock])).rows[0].id);
      }
      await c.query('delete from variants where product_id=$1 and not(id=any($2::int[]))', [pid, keep]);
      await c.query('commit');
      r.json({ id: pid });
    } catch (error) { await c.query('rollback'); r.status(400).json({ erro: error.message }); } finally { c.release(); }
  }));
  app.delete('/api/admin/products/:id', adm, W(async (q, r) => { await db.query('delete from products where id=$1', [q.params.id]); r.json({ ok: 1 }); }));
  app.get('/api/admin/orders', adm, W(async (q, r) => r.json((await store.listAdmin()).map(order => { const view = { ...order }; delete view.mp_checkout_url; delete view.mp_idempotency_key; delete view.request_hash; return view; }))));
  app.patch('/api/admin/orders/:id', adm, W(async (q, r) => {
    const id = Number(q.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !ORDER_STATUSES.includes(q.body?.status)) return r.status(400).json({ erro: 'Status inválido.' });
    const order = await store.setStatus(id, q.body.status);
    if (!order) return r.status(404).json({ erro: 'Pedido não encontrado.' });
    r.json({ ok: 1 });
  }));
  app.all(['/api/products', '/api/config', '/api/frete/:cep', '/api/orders', '/api/orders/mine', '/api/orders/:id/checkout', '/api/orders/:id/sync', '/api/payments/webhook', '/api/login', '/api/register', '/api/admin/login', '/api/admin/products', '/api/admin/products/:id', '/api/admin/orders', '/api/admin/orders/:id', '/api/visits', '/api/visits/:session', '/api/admin/insights', '/api/health'], (q, r) => r.status(405).json({ erro: 'Método não permitido para este endereço.' }));
  app.use('/api', (q, r) => r.status(404).json({ erro: 'Rota não encontrada' }));
  app.use((q, r) => r.status(404).send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Página não encontrada</title><body style="background:#080808;color:#eee;font-family:Arial;padding:40px"><h1>Página não encontrada</h1><p>Este endereço não está disponível.</p><a style="color:#dfb358" href="/">Voltar à loja</a></body></html>'));
  app.use((error, q, r, n) => { console.error('http', error.message); r.status(error.status === 400 ? 400 : 500).json({ erro: error.status === 400 ? 'Informações inválidas.' : 'Serviço temporariamente indisponível.' }); });
  const autoListen = options.autoListen !== undefined ? options.autoListen : require.main === module;
  if (autoListen) insightsReady.then(() => app.listen(env.PORT || 3000)).catch(error => { console.error('Falha ao iniciar relatórios:', error.message); process.exit(1); });
  return { app, store, mp, ready: insightsReady };
}

if (require.main === module) {
  process.on('unhandledRejection', error => console.error('erro', error && error.message));
  try { createApp(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { createApp };
