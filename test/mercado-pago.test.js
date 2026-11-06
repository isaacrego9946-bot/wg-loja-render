'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { createApp } = require('../server');
const { createMemoryStore } = require('./memory-store');
const { signatureHeader, verifyWebhookSignature, buildManifest } = require('../lib/mp');

const SECRET = 'test-secret-com-24-caracteres-ok';
const TOKEN = 'APP_USR-teste-nao-usar';
const WEBHOOK = 'segredo-de-teste-webhook';
const baseEnv = {
  JWT_SECRET: SECRET,
  ADMIN_PASSWORD: 'senha-admin-teste',
  WHATSAPP: '5511999999999',
  PIX_KEY: 'chave-publica-teste',
  MP_ACCESS_TOKEN: TOKEN,
  MP_WEBHOOK_SECRET: WEBHOOK,
  APP_BASE_URL: 'https://loja.exemplo.test',
  MP_MODE: 'test',
  MP_COLLECTOR_ID: '42',
};

function variant(stock = 5) {
  return { id: 1, product_id: 1, name: 'Camiseta', price: '100.00', size: 'M', color: 'Preto', stock };
}

function testDb() {
  return {
    on() {},
    async query(sql) {
      if (String(sql).includes('from products p')) {
        return { rows: [{ id: 1, name: 'Camiseta', category: 'Camisetas', price: '100.00', image: '', description: '', variants: [{ id: 1, size: 'M', color: 'Preto', stock: 5 }] }] };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() { throw new Error('conexão inesperada'); },
  };
}

function mockMp() {
  const preferences = new Map();
  const payments = new Map();
  const calls = [];
  let created = 0;
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers, body: options.body });
    if (!String(options.headers?.Authorization || '').startsWith('Bearer ')) return { ok: false, status: 401, json: {} };
    if (url.endsWith('/checkout/preferences')) {
      const key = options.headers['X-Idempotency-Key'];
      if (preferences.has(key)) return { ok: true, status: 200, json: preferences.get(key) };
      created += 1;
      const body = JSON.parse(options.body);
      const id = `pref-${created}`;
      const preference = {
        id, collector_id: 42,
        sandbox_init_point: `https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`,
        init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`,
        items: body.items, shipments: body.shipments,
      };
      preferences.set(key, preference);
      return { ok: true, status: 201, json: preference };
    }
    if (url.includes('/v1/payments/search?')) {
      const reference = new URL(url).searchParams.get('external_reference');
      return { ok: true, status: 200, json: { results: [...payments.values()].filter(payment => payment.external_reference === reference) } };
    }
    const payment = url.match(/\/v1\/payments\/([^?/]+)$/);
    if (payment) {
      const found = payments.get(decodeURIComponent(payment[1]));
      return found ? { ok: true, status: 200, json: found } : { ok: false, status: 404, json: {} };
    }
    return { ok: false, status: 404, json: {} };
  };
  return { impl, calls, payments, created: () => created };
}

async function boot(t, { env = {}, stock = 5, fetchImpl } = {}) {
  const mp = fetchImpl || mockMp();
  const store = createMemoryStore({ variants: [variant(stock)] });
  const { app } = createApp({ env: { ...baseEnv, ...env }, db: testDb(), store, fetchImpl: mp.impl, autoListen: false });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { store, mp, base: `http://127.0.0.1:${server.address().port}` };
}

async function send(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : {}; } catch { /* resposta HTML */ }
  return { status: response.status, body: payload, text };
}

function orderBody(extra = {}) {
  return {
    customer_name: 'Maria Silva', phone: '11988887777', address: 'Rua das Flores, 100', cep: '14010000',
    delivery: 'entrega', payment: 'pix', request_key: crypto.randomUUID(),
    items: [{ variant_id: 1, qty: 1, price: 0.01, name: 'Falsificado' }], total: 0.01, shipping: 0, ...extra,
  };
}

function payment(order, extra = {}) {
  return {
    id: '900', status: 'approved', status_detail: 'accredited', transaction_amount: order.total, transaction_amount_refunded: 0,
    currency_id: 'BRL', external_reference: `wg-order-${order.id}`, live_mode: false, collector_id: 42,
    payment_method_id: 'pix', payment_type_id: 'bank_transfer', installments: 1, ...extra,
  };
}

function signedHeaders(dataId, requestId, ts = Math.floor(Date.now() / 1000), secret = WEBHOOK) {
  return { 'x-signature': signatureHeader(secret, dataId, requestId, ts), 'x-request-id': requestId, 'Content-Type': 'application/json' };
}

test('assinatura: manifesto oficial, caixa, prazo e comparação', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const manifest = buildManifest('AbC12', 'req-1', ts);
  assert.equal(manifest, `id:AbC12;request-id:req-1;ts:${ts};`);
  assert.equal(buildManifest('', 'req-1', ts), `request-id:req-1;ts:${ts};`);
  const ok = verifyWebhookSignature({ secret: WEBHOOK, xSignature: signatureHeader(WEBHOOK, 'AbC12', 'req-1', ts), xRequestId: 'req-1', dataId: 'AbC12', toleranceSeconds: 300 });
  assert.equal(ok.dataId, 'AbC12');
  const lower = verifyWebhookSignature({ secret: WEBHOOK, xSignature: signatureHeader(WEBHOOK, 'abc12', 'req-1', ts), xRequestId: 'req-1', dataId: 'AbC12', toleranceSeconds: 300 });
  assert.equal(lower.dataId, 'abc12');
  const millis = String(Date.now());
  assert.equal(verifyWebhookSignature({ secret: WEBHOOK, xSignature: signatureHeader(WEBHOOK, '10', 'req-2', millis), xRequestId: 'req-2', dataId: '10', toleranceSeconds: 300 }).dataId, '10');
  assert.throws(() => verifyWebhookSignature({ secret: 'outro', xSignature: signatureHeader(WEBHOOK, '10', 'req-2', ts), xRequestId: 'req-2', dataId: '10', toleranceSeconds: 300 }));
  assert.throws(() => verifyWebhookSignature({ secret: WEBHOOK, xSignature: signatureHeader(WEBHOOK, '10', 'req-2', String(Math.floor(Date.now() / 1000) - 1000)), xRequestId: 'req-2', dataId: '10', toleranceSeconds: 300 }));
});

test('preço, frete e quantidade são calculados no servidor', async t => {
  const { base, store } = await boot(t);
  const tampered = await send(base, '/api/orders', { method: 'POST', body: orderBody({ items: [{ variant_id: 1, qty: 2, price: 0.01 }], shipping: 0, total: 1 }) });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.body.total, 215);
  assert.equal(tampered.body.items[0].price, 100);
  assert.match(tampered.body.checkout_url, /^https:\/\/sandbox\.mercadopago\.com\.br\//);
  assert.equal(tampered.text.includes(TOKEN), false);
  const otherCep = await send(base, '/api/orders', { method: 'POST', body: orderBody({ cep: '01310100' }) });
  assert.equal(otherCep.body.total, 130);
  const pickup = await send(base, '/api/orders', { method: 'POST', body: orderBody({ delivery: 'retirada', address: '', cep: '' }) });
  assert.equal(pickup.body.total, 100);
  const fraction = await send(base, '/api/orders', { method: 'POST', body: orderBody({ items: [{ variant_id: 1, qty: 1.5 }] }) });
  assert.equal(fraction.status, 400);
  assert.equal(store.stockOf(1), 1);
});

test('preferência de cartão pede parcelas e a de Pix não usa o link de produção', async t => {
  const { base, mp } = await boot(t);
  const card = await send(base, '/api/orders', { method: 'POST', body: orderBody({ payment: 'cartao' }) });
  assert.equal(card.status, 200);
  const created = mp.calls.find(call => call.url.endsWith('/checkout/preferences'));
  const body = JSON.parse(created.body);
  assert.equal(body.payment_methods.installments, 12);
  assert.equal(body.binary_mode, false);
  assert.match(body.notification_url, /\/api\/payments\/webhook\?source_news=webhooks$/);
  assert.equal(body.items[0].currency_id, 'BRL');
  assert.equal(body.items[0].unit_price, 100);
  assert.equal(body.shipments.cost, 15);
  assert.ok(body.payment_methods.excluded_payment_types.some(type => type.id === 'bank_transfer'));
  assert.equal(created.headers.Authorization, `Bearer ${TOKEN}`);
  const pix = await send(base, '/api/orders', { method: 'POST', body: orderBody() });
  const pixBody = JSON.parse(mp.calls.filter(call => call.url.endsWith('/checkout/preferences')).at(-1).body);
  assert.equal(pixBody.payment_methods.installments, undefined);
  assert.equal(pixBody.payment_methods.default_payment_method_id, 'pix');
  assert.equal(pix.body.checkout_url.includes('sandbox.mercadopago'), true);
  assert.equal(pix.body.checkout_url.includes('www.mercadopago.com.br/checkout'), false);
});

test('preferência duplicada reutiliza o mesmo pedido e o mesmo link', async t => {
  const { base, mp, store } = await boot(t, { stock: 1 });
  const body = orderBody();
  const [first, second] = await Promise.all([
    send(base, '/api/orders', { method: 'POST', body }),
    send(base, '/api/orders', { method: 'POST', body }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.id, second.body.id);
  assert.equal(first.body.checkout_url, second.body.checkout_url);
  assert.equal(mp.created(), 1);
  assert.equal(store.stockOf(1), 0);
  const changed = await send(base, '/api/orders', { method: 'POST', body: { ...body, items: [{ variant_id: 1, qty: 1 }] } });
  assert.equal(changed.status, 400);
});

test('sem credenciais o catálogo continua e o pedido volta ao WhatsApp', async t => {
  const { base, mp } = await boot(t, { env: { MP_ACCESS_TOKEN: '', MP_WEBHOOK_SECRET: '', APP_BASE_URL: '' } });
  const products = await send(base, '/api/products');
  assert.equal(products.status, 200);
  assert.equal(products.body[0].name, 'Camiseta');
  assert.equal(products.text.includes(TOKEN), false);
  const config = await send(base, '/api/config');
  assert.equal(config.body.mercadopago.ativo, false);
  assert.equal(config.body.pix, 'chave-publica-teste');
  const order = await send(base, '/api/orders', { method: 'POST', body: orderBody() });
  assert.equal(order.status, 200);
  assert.equal(order.body.checkout_url, undefined);
  assert.equal(order.body.total, 115);
  assert.equal(mp.created(), 0);
});

test('produção fica bloqueada sem a trava explícita', async t => {
  const { base, mp } = await boot(t, { env: { MP_MODE: 'production', MP_ALLOW_PRODUCTION: 'false' } });
  const config = await send(base, '/api/config');
  assert.equal(config.body.mercadopago.ativo, false);
  const order = await send(base, '/api/orders', { method: 'POST', body: orderBody() });
  assert.equal(order.body.checkout_url, undefined);
  assert.equal(mp.created(), 0);
});

test('webhook rejeita assinatura inválida, prazo vencido, id trocado e caminho indevido', async t => {
  const { base, mp, store } = await boot(t);
  const key = crypto.randomUUID();
  const order = (await send(base, '/api/orders', { method: 'POST', body: orderBody({ request_key: key }) })).body;
  const before = mp.calls.filter(call => /\/v1\/payments\/900$/.test(call.url)).length;
  const bad = await send(base, '/api/payments/webhook?data.id=900&type=payment', { method: 'POST', headers: signedHeaders('900', 'req-bad', Math.floor(Date.now() / 1000), 'segredo-errado'), body: { status: 'approved' } });
  assert.equal(bad.status, 401);
  const stale = await send(base, '/api/payments/webhook?data.id=900&type=payment', { method: 'POST', headers: signedHeaders('900', 'req-stale', Math.floor(Date.now() / 1000) - 1000), body: {} });
  assert.equal(stale.status, 401);
  const traversal = await send(base, '/api/payments/webhook?data.id=../admin&type=payment', { method: 'POST', headers: signedHeaders('../admin', 'req-path'), body: {} });
  assert.equal(traversal.status, 401);
  assert.equal(mp.calls.filter(call => /\/v1\/payments\/900$/.test(call.url)).length, before);
  const view = await send(base, '/api/orders/' + order.id + '/sync', { method: 'POST', body: { request_key: key } });
  assert.equal(view.body.status, 'Novo');
  assert.equal(store.stockOf(1), 4);
});

test('pagamento recusado não marca pago nem devolve o estoque', async t => {
  const { base, mp, store } = await boot(t, { stock: 1 });
  const key = crypto.randomUUID();
  const order = (await send(base, '/api/orders', { method: 'POST', body: orderBody({ request_key: key }) })).body;
  mp.payments.set('60', payment(order, { id: '60', status: 'rejected' }));
  const response = await send(base, '/api/payments/webhook?data.id=60&type=payment', { method: 'POST', headers: signedHeaders('60', 'rejected'), body: { status: 'approved' } });
  assert.equal(response.status, 200);
  const view = await send(base, '/api/orders/' + order.id + '/sync', { method: 'POST', body: { request_key: key } });
  assert.equal(view.body.status, 'Recusado');
  assert.notEqual(view.body.status, 'Pago');
  assert.equal(store.stockOf(1), 0);
});

test('produção explícita usa o link real e recusa pagamento de teste', async t => {
  const { base, mp } = await boot(t, { env: { MP_MODE: 'production', MP_ALLOW_PRODUCTION: 'true' } });
  const key = crypto.randomUUID();
  const order = (await send(base, '/api/orders', { method: 'POST', body: orderBody({ request_key: key }) })).body;
  assert.match(order.checkout_url, /^https:\/\/www\.mercadopago\.com\.br\//);
  assert.equal(order.checkout_url.includes('sandbox'), false);
  mp.payments.set('50', payment(order, { id: '50', live_mode: false, status: 'approved' }));
  await send(base, '/api/payments/webhook?data.id=50&type=payment', { method: 'POST', headers: signedHeaders('50', 'prod-test'), body: {} });
  assert.equal((await send(base, '/api/orders/' + order.id + '/sync', { method: 'POST', body: { request_key: key } })).body.status, 'Novo');
  mp.payments.set('50', payment(order, { id: '50', live_mode: true, status: 'approved' }));
  await send(base, '/api/payments/webhook?data.id=50&type=payment', { method: 'POST', headers: signedHeaders('50', 'prod-live'), body: {} });
  assert.equal((await send(base, '/api/orders/' + order.id + '/sync', { method: 'POST', body: { request_key: key } })).body.status, 'Pago');
});

test('valor, referência, ambiente e duplicidade não marcam pedido pago', async t => {
  const { base, mp, store } = await boot(t, { stock: 2 });
  const created = await send(base, '/api/orders', { method: 'POST', body: orderBody() });
  const order = created.body;
  const key = orderBody().request_key;
  const placed = await send(base, '/api/orders', { method: 'POST', body: { ...orderBody(), request_key: key } });
  assert.equal(placed.body.total, 115);
  mp.payments.set('1', payment(placed.body, { id: '1', transaction_amount: 1 }));
  const wrongAmount = await send(base, '/api/payments/webhook?data.id=1&type=payment', { method: 'POST', headers: signedHeaders('1', 'amount'), body: { status: 'approved', transaction_amount: placed.body.total } });
  assert.equal(wrongAmount.status, 200);
  mp.payments.set('2', payment(placed.body, { id: '2', external_reference: 'wg-order-999' }));
  const wrongRef = await send(base, '/api/payments/webhook?data.id=2&type=payment', { method: 'POST', headers: signedHeaders('2', 'reference'), body: { status: 'approved' } });
  assert.equal(wrongRef.status, 200);
  mp.payments.set('3', payment(placed.body, { id: '3', live_mode: true }));
  const live = await send(base, '/api/payments/webhook?data.id=3&type=payment', { method: 'POST', headers: signedHeaders('3', 'live'), body: { status: 'approved' } });
  assert.equal(live.status, 200);
  const guest = await send(base, '/api/orders/' + placed.body.id + '/sync', { method: 'POST', body: { request_key: key, status: 'approved' } });
  assert.equal(guest.status, 200);
  assert.equal(guest.body.status, 'Novo');
  assert.equal(guest.text.includes(TOKEN), false);
  assert.equal(guest.text.includes(WEBHOOK), false);
  mp.payments.set('4', payment(placed.body, { id: '4', status: 'pending' }));
  const pending = await send(base, '/api/payments/webhook?data.id=4&type=payment', { method: 'POST', headers: signedHeaders('4', 'pending'), body: { status: 'approved' } });
  assert.equal(pending.status, 200);
  const pendingView = await send(base, '/api/orders/' + placed.body.id + '/sync', { method: 'POST', body: { request_key: key } });
  assert.equal(pendingView.body.status, 'Pendente');
  assert.notEqual(pendingView.body.status, 'Pago');
  mp.payments.set('4', payment(placed.body, { id: '4', status: 'approved', payment_method_id: 'visa', payment_type_id: 'credit_card', installments: 3 }));
  const approved = await send(base, '/api/payments/webhook?data.id=4&type=payment', { method: 'POST', headers: signedHeaders('4', 'approved'), body: {} });
  assert.equal(approved.status, 200);
  const again = await send(base, '/api/payments/webhook?data.id=4&type=payment', { method: 'POST', headers: signedHeaders('4', 'approved-again'), body: { status: 'approved' } });
  assert.equal(again.status, 200);
  const paid = await send(base, '/api/orders/' + placed.body.id + '/sync', { method: 'POST', body: { request_key: key } });
  assert.equal(paid.body.status, 'Pago');
  assert.equal(paid.body.installments, 3);
  assert.equal(store.stockOf(1), 0);
  const conflict = await send(base, '/api/payments/webhook?data.id=5&type=payment', { method: 'POST', headers: signedHeaders('5', 'approved'), body: {} });
  assert.equal(conflict.status, 401);
  mp.payments.set('4', payment(placed.body, { id: '4', status: 'refunded' }));
  const refund = await send(base, '/api/payments/webhook?data.id=4&type=payment', { method: 'POST', headers: signedHeaders('4', 'refund'), body: {} });
  assert.equal(refund.status, 200);
  const refunded = await send(base, '/api/orders/' + placed.body.id + '/sync', { method: 'POST', body: { request_key: key } });
  assert.equal(refunded.body.status, 'Reembolsado');
  assert.equal(store.stockOf(1), 1);
  const refundAgain = await send(base, '/api/payments/webhook?data.id=4&type=payment', { method: 'POST', headers: signedHeaders('4', 'refund-2'), body: {} });
  assert.equal(refundAgain.status, 200);
  assert.equal(store.stockOf(1), 1);
  assert.equal(order.status, 'Novo');
});

test('retorno do navegador não marca pago; a consulta ao provedor marca', async t => {
  const { base, mp } = await boot(t);
  const key = crypto.randomUUID();
  const order = (await send(base, '/api/orders', { method: 'POST', body: orderBody({ request_key: key }) })).body;
  const page = await send(base, `/?status=approved&payment_id=1&external_reference=wg-order-${order.id}`);
  assert.equal(page.status, 200);
  assert.equal(String(page.text).includes('<html'), true);
  const untouched = await send(base, '/api/orders/' + order.id + '/sync', { method: 'POST', body: { request_key: key, status: 'approved' } });
  assert.equal(untouched.body.status, 'Novo');
  mp.payments.set('77', payment(order, { id: '77', status: 'approved' }));
  const checked = await send(base, '/api/orders/' + order.id + '/sync', { method: 'POST', body: { request_key: key } });
  assert.equal(checked.body.status, 'Pago');
});

test('controle de acesso entre clientes, visitante e admin', async t => {
  const { base, store } = await boot(t, { stock: 4 });
  const tokenA = jwt.sign({ id: 2, name: 'Ana' }, SECRET);
  const tokenB = jwt.sign({ id: 3, name: 'Bia' }, SECRET);
  const keyA = crypto.randomUUID();
  const keyGuest = crypto.randomUUID();
  const mineA = await send(base, '/api/orders', { method: 'POST', token: tokenA, body: orderBody({ request_key: keyA }) });
  const guest = await send(base, '/api/orders', { method: 'POST', body: orderBody({ request_key: keyGuest, customer_name: 'Visitante' }) });
  const listA = await send(base, '/api/orders/mine', { token: tokenA });
  assert.equal(listA.status, 200);
  assert.deepEqual(listA.body.map(order => order.id), [mineA.body.id]);
  assert.equal(JSON.stringify(listA.body).includes(keyA), false);
  const listB = await send(base, '/api/orders/mine', { token: tokenB });
  assert.deepEqual(listB.body, []);
  const stolen = await send(base, '/api/orders/' + mineA.body.id + '/sync', { method: 'POST', token: tokenB, body: { request_key: keyGuest } });
  assert.equal(stolen.status, 404);
  const guestDenied = await send(base, '/api/orders/' + guest.body.id + '/sync', { method: 'POST', body: { request_key: keyA } });
  assert.equal(guestDenied.status, 404);
  const guestOk = await send(base, '/api/orders/' + guest.body.id + '/sync', { method: 'POST', body: { request_key: keyGuest } });
  assert.equal(guestOk.status, 200);
  assert.equal(guestOk.body.id, guest.body.id);
  const noLogin = await send(base, '/api/orders/mine');
  assert.equal(noLogin.status, 401);
  const admin = jwt.sign({ admin: 1 }, SECRET);
  const orders = await send(base, '/api/admin/orders', { token: admin });
  assert.equal(orders.status, 200);
  assert.equal(orders.body.some(order => order.id === guest.body.id), true);
  assert.equal(JSON.stringify(orders.body).includes('mp_checkout_url'), false);
  assert.equal(JSON.stringify(orders.body).includes(TOKEN), false);
  const customerAdmin = await send(base, '/api/admin/orders', { token: tokenA });
  assert.equal(customerAdmin.status, 401);
  assert.equal(store.stockOf(1), 2);
  const cancelled = await send(base, '/api/admin/orders/' + guest.body.id, { method: 'PATCH', token: admin, body: { status: 'Cancelado' } });
  assert.equal(cancelled.status, 200);
  assert.equal(store.stockOf(1), 3);
  const again = await send(base, '/api/admin/orders/' + guest.body.id, { method: 'PATCH', token: admin, body: { status: 'Cancelado' } });
  assert.equal(again.status, 200);
  assert.equal(store.stockOf(1), 3);
  const invalid = await send(base, '/api/admin/orders/' + guest.body.id, { method: 'PATCH', token: admin, body: { status: 'Pago via WhatsApp' } });
  assert.equal(invalid.status, 400);
});

test('arquivos públicos e o exemplo de ambiente não carregam segredo', () => {
  const files = ['public/store.js', 'public/config.js', 'public/admin.html', '.env.example', 'docs/mercado-pago.md'];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(TOKEN), false, file);
    assert.equal(text.includes(WEBHOOK), false, file);
    assert.equal(text.includes('APP_USR-'), false, file);
  }
});
