'use strict';

const crypto = require('crypto');
const { toCents, centsToDecimal } = require('./money');

const FULFILLMENT = new Set(['Separando', 'Enviado', 'Entregue']);
const PENDING = new Set(['pending', 'in_process', 'in_mediation', 'authorized']);
const KNOWN = new Set([...PENDING, 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back', 'partially_refunded']);

function fail(message, status = 400) {
  const error = new Error(message);
  error.expose = true;
  error.status = status;
  return error;
}

function isPublicHttps(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.)/.test(host)) return false;
  return true;
}

function readConfig(env) {
  const modeRaw = String(env.MP_MODE || 'test').trim().toLowerCase();
  const mode = modeRaw === 'production' ? 'production' : modeRaw === 'test' ? 'test' : 'invalid';
  const token = String(env.MP_ACCESS_TOKEN || '').trim();
  const secret = String(env.MP_WEBHOOK_SECRET || '').trim();
  const base = String(env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  const allowProduction = env.MP_ALLOW_PRODUCTION === 'true';
  const maxInstallments = env.MP_MAX_INSTALLMENTS === undefined || env.MP_MAX_INSTALLMENTS === '' ? 12 : Number(env.MP_MAX_INSTALLMENTS);
  const tolerance = env.MP_WEBHOOK_TOLERANCE_SECONDS === undefined || env.MP_WEBHOOK_TOLERANCE_SECONDS === '' ? 300 : Number(env.MP_WEBHOOK_TOLERANCE_SECONDS);
  const collector = String(env.MP_COLLECTOR_ID || '').trim();
  let reason = 'ausente';
  let enabled = false;
  if (mode === 'invalid') reason = 'modo';
  else if (mode === 'production' && !allowProduction) reason = 'producao_bloqueada';
  else if (!token || !secret || !base) reason = 'ausente';
  else if (!isPublicHttps(base)) reason = 'url';
  else if (!Number.isInteger(maxInstallments) || maxInstallments < 1 || maxInstallments > 12) reason = 'parcelas';
  else if (!Number.isInteger(tolerance) || tolerance < 30 || tolerance > 3600) reason = 'tolerancia';
  else {
    enabled = true;
    reason = mode === 'production' ? 'producao' : 'teste';
  }
  return { enabled, mode: mode === 'production' ? 'production' : 'test', token, secret, base, allowProduction, maxInstallments, tolerance, collector, reason };
}

function externalReference(orderId) {
  return `wg-order-${orderId}`;
}

function buildManifest(dataId, requestId, ts) {
  const parts = [];
  if (dataId) parts.push(`id:${dataId}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);
  return `${parts.join(';')};`;
}

function signatureHeader(secret, dataId, requestId, ts) {
  const manifest = buildManifest(dataId, requestId, ts);
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

function normalise(value) {
  if (value === undefined || value === null) return '';
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? '').trim();
}

function timestampMs(ts) {
  if (!/^\d+$/.test(ts)) return null;
  const value = Number(ts);
  if (!Number.isSafeInteger(value)) return null;
  return value >= 1e11 ? value : value * 1000;
}

function sameHex(left, right) {
  const a = Buffer.from(String(left).toLowerCase());
  const b = Buffer.from(String(right).toLowerCase());
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWebhookSignature({ secret, xSignature, xRequestId, dataId, toleranceSeconds, now = Date.now }) {
  const header = normalise(xSignature);
  const requestId = normalise(xRequestId);
  const id = normalise(dataId);
  if (!header) throw fail('Assinatura inválida.', 401);
  let ts = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    if (key === 'v1') v1 = value;
  }
  if (!/^\d+$/.test(ts) || !/^[a-f0-9]{64}$/i.test(v1)) throw fail('Assinatura inválida.', 401);
  const digest = manifest => crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  let matchedId = null;
  if (sameHex(digest(buildManifest(id, requestId, ts)), v1)) matchedId = id;
  else if (id && id !== id.toLowerCase() && sameHex(digest(buildManifest(id.toLowerCase(), requestId, ts)), v1)) matchedId = id.toLowerCase();
  if (matchedId === null && id) throw fail('Assinatura inválida.', 401);
  if (matchedId === null && !sameHex(digest(buildManifest(id, requestId, ts)), v1)) throw fail('Assinatura inválida.', 401);
  const ms = timestampMs(ts);
  if (ms === null) throw fail('Assinatura inválida.', 401);
  const drift = Math.abs(now() - ms) / 1000;
  if (drift > toleranceSeconds) throw fail('Assinatura inválida.', 401);
  return { dataId: matchedId === null ? id : matchedId, requestId, ts };
}

function resourceId(value) {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail('Identificador de pagamento inválido.', 401);
  return id;
}

function checkoutUrl(preference, mode) {
  const raw = mode === 'production' ? preference.init_point : preference.sandbox_init_point;
  let url;
  try { url = new URL(String(raw || '')); } catch { throw fail('Link de pagamento indisponível.', 502); }
  const host = url.hostname.toLowerCase();
  const mercadoPago = host === 'mercadopago.com' || host === 'mercadopago.com.br' || host.endsWith('.mercadopago.com') || host.endsWith('.mercadopago.com.br');
  const sandbox = host.startsWith('sandbox.') || url.pathname.includes('/sandbox');
  if (url.protocol !== 'https:' || !mercadoPago || (mode === 'test' && !sandbox) || (mode === 'production' && sandbox)) {
    throw fail('Link de pagamento indisponível.', 502);
  }
  return url.toString();
}

function preferenceTotalCents(preference) {
  if (!Array.isArray(preference.items) || !preference.items.length) return null;
  let sum = 0;
  for (const item of preference.items) sum += toCents(item.unit_price) * Number(item.quantity);
  if (preference.shipments && preference.shipments.cost != null && preference.shipments.cost !== '') sum += toCents(preference.shipments.cost);
  return sum;
}

function buildPreference(order, config) {
  const items = order.items.map(item => ({
    id: String(item.variant_id || item.product_id),
    title: String(`${item.name} ${item.size || ''}/${item.color || ''}`).replace(/\s+/g, ' ').trim().slice(0, 256),
    quantity: item.qty,
    currency_id: 'BRL',
    unit_price: Number(centsToDecimal(toCents(item.price))),
  }));
  const shipping = toCents(order.shipping);
  const body = {
    items,
    external_reference: externalReference(order.id),
    notification_url: `${config.base}/api/payments/webhook?source_news=webhooks`,
    back_urls: {
      success: `${config.base}/`,
      pending: `${config.base}/`,
      failure: `${config.base}/`,
    },
    auto_return: 'approved',
    binary_mode: false,
    metadata: { order_id: String(order.id) },
    payment_methods: order.payment === 'pix'
      ? {
          default_payment_method_id: 'pix',
          excluded_payment_types: ['credit_card', 'debit_card', 'ticket', 'prepaid_card'].map(id => ({ id })),
        }
      : {
          installments: config.maxInstallments,
          default_installments: 1,
          excluded_payment_types: ['ticket', 'bank_transfer', 'atm', 'prepaid_card'].map(id => ({ id })),
        },
  };
  if (shipping > 0) body.shipments = { cost: Number(centsToDecimal(shipping)), mode: 'not_specified' };
  const phone = String(order.customer?.phone || '').replace(/\D/g, '');
  if (order.customer?.name) {
    body.payer = { name: String(order.customer.name).slice(0, 100) };
    if (phone) body.payer.phone = { number: phone };
  }
  if (preferenceTotalCents(body) !== toCents(order.total)) throw fail('Total do pagamento não confere com o pedido.', 500);
  return body;
}

function normalizedStatus(payment) {
  const status = String(payment.status || '');
  const refunded = toCents(payment.transaction_amount_refunded || 0);
  const amount = toCents(payment.transaction_amount);
  if (status === 'approved' && refunded > 0 && refunded < amount) return 'partially_refunded';
  if (status === 'approved' && amount > 0 && refunded >= amount) return 'refunded';
  return status;
}

function assessPayment(order, payment, config) {
  const reasons = [];
  if (String(payment.external_reference || '') !== externalReference(order.id)) reasons.push('referencia');
  if (String(payment.currency_id || '').toUpperCase() !== 'BRL') reasons.push('moeda');
  try {
    if (toCents(payment.transaction_amount) !== toCents(order.total)) reasons.push('valor');
  } catch {
    reasons.push('valor');
  }
  if (typeof payment.live_mode !== 'boolean' || payment.live_mode !== (config.mode === 'production')) reasons.push('ambiente');
  const expected = String(order.mp_collector_id || '');
  if (!expected || String(payment.collector_id ?? '') !== expected) reasons.push('recebedor');
  if (config.collector && String(payment.collector_id ?? '') !== config.collector) reasons.push('recebedor');
  if (order.mp_preference_id && payment.preference_id && String(payment.preference_id) !== String(order.mp_preference_id)) reasons.push('preferencia');
  try { resourceId(payment.id); } catch { reasons.push('id'); }
  const status = reasons.includes('valor') ? '' : normalizedStatus(payment);
  if (!KNOWN.has(status)) reasons.push('status');
  return { ok: reasons.length === 0, reasons, status };
}

function foldPayments(rows) {
  const statuses = rows.map(row => row.status);
  if (statuses.includes('approved')) return 'Pago';
  if (statuses.includes('partially_refunded')) return 'Parcialmente reembolsado';
  if (statuses.includes('charged_back')) return 'Contestado';
  if (statuses.includes('refunded')) return 'Reembolsado';
  if (statuses.some(status => PENDING.has(status))) return 'Pendente';
  if (statuses.includes('cancelled')) return 'Cancelado';
  if (statuses.includes('rejected')) return 'Recusado';
  return null;
}

function chooseStatus(current, folded) {
  if (!folded) return current;
  if (FULFILLMENT.has(current)) {
    if (folded === 'Reembolsado' || folded === 'Contestado' || folded === 'Parcialmente reembolsado') return folded;
    return current;
  }
  if (['Pago', 'Parcialmente reembolsado', 'Reembolsado', 'Contestado'].includes(current) && ['Pendente', 'Recusado', 'Novo'].includes(folded)) return current;
  if (['Reembolsado', 'Contestado'].includes(current) && folded === 'Pago') return current;
  return folded;
}

function createClient(config, fetchImpl = globalThis.fetch) {
  async function request(path, options = {}) {
    const response = await fetchImpl(`https://api.mercadopago.com${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.idempotencyKey ? { 'X-Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = typeof response.json === 'function' ? await response.json() : response.json;
    if (!response.ok) {
      const error = fail('Mercado Pago recusou a operação.', 502);
      error.mpStatus = response.status;
      throw error;
    }
    return json || {};
  }
  return {
    config,
    inflight: new Map(),
    createPreference: (body, idempotencyKey) => request('/checkout/preferences', { method: 'POST', body, idempotencyKey }),
    getPayment: id => request(`/v1/payments/${encodeURIComponent(resourceId(id))}`),
    getMerchantOrder: id => request(`/merchant_orders/${encodeURIComponent(resourceId(id))}`),
    searchPayments: reference => request(`/v1/payments/search?sort=date_created&criteria=desc&limit=20&external_reference=${encodeURIComponent(reference)}`),
  };
}

module.exports = {
  readConfig,
  externalReference,
  buildManifest,
  signatureHeader,
  verifyWebhookSignature,
  resourceId,
  checkoutUrl,
  buildPreference,
  preferenceTotalCents,
  assessPayment,
  normalizedStatus,
  foldPayments,
  chooseStatus,
  createClient,
  fail,
};
