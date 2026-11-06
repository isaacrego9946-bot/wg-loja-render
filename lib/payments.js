'use strict';

const crypto = require('crypto');
const { toCents, centsToDecimal } = require('./money');
const {
  externalReference, verifyWebhookSignature, buildPreference, preferenceTotalCents, checkoutUrl, assessPayment,
  foldPayments, chooseStatus, resourceId, fail,
} = require('./mp');

const RESTOCK_FROM = new Set(['Novo', 'Pendente', 'Recusado', 'Pago']);
const SHIPPED = new Set(['Separando', 'Enviado', 'Entregue']);

function paymentRow(order, payment, decision) {
  return {
    payment_id: String(payment.id),
    order_id: order.id,
    status: decision.status || String(payment.status || 'rejected'),
    amount_cents: (() => { try { return toCents(payment.transaction_amount); } catch { return -1; } })(),
    currency: String(payment.currency_id || ''),
    live_mode: payment.live_mode === true,
    installments: Number.isSafeInteger(payment.installments) && payment.installments > 0 ? payment.installments : null,
    payment_method: payment.payment_method_id ? String(payment.payment_method_id).slice(0, 40) : null,
    payment_type: payment.payment_type_id ? String(payment.payment_type_id).slice(0, 40) : null,
    accepted: decision.ok,
  };
}

async function applyPayment(store, orderId, payment, config) {
  return store.transaction(async tx => {
    const order = await tx.getOrder(orderId);
    if (!order) return null;
    const decision = assessPayment(order, payment, config);
    const saved = await tx.upsertPayment(paymentRow(order, payment, decision));
    if (!saved) return tx.getOrder(orderId);
    if (!decision.ok) return tx.getOrder(orderId);
    const accepted = (await tx.listPayments(order.id)).filter(row => row.accepted);
    const folded = foldPayments(accepted);
    const next = chooseStatus(order.status, folded);
    const representative = [...accepted].reverse().find(row => (
      (folded === 'Pago' && row.status === 'approved') ||
      (folded === 'Parcialmente reembolsado' && row.status === 'partially_refunded') ||
      (folded === 'Contestado' && row.status === 'charged_back') ||
      (folded === 'Reembolsado' && row.status === 'refunded') ||
      (folded === 'Pendente' && ['pending', 'in_process', 'in_mediation', 'authorized'].includes(row.status)) ||
      (folded === 'Cancelado' && row.status === 'cancelled') ||
      (folded === 'Recusado' && row.status === 'rejected')
    )) || accepted[accepted.length - 1];
    await tx.saveOrder(order.id, {
      status: next,
      mp_status: folded,
      mp_payment_id: representative ? representative.payment_id : order.mp_payment_id,
      mp_installments: representative ? representative.installments : order.mp_installments,
      mp_payment_method: representative ? representative.payment_method : order.mp_payment_method,
    });
    const updated = await tx.getOrder(orderId);
    if (['Cancelado', 'Reembolsado', 'Contestado'].includes(next) && !updated.stock_restored && RESTOCK_FROM.has(order.status) && !SHIPPED.has(order.status)) {
      await tx.restoreStock(updated);
    }
    return tx.getOrder(orderId);
  });
}

async function attachPreference(store, mp, orderId) {
  if (!mp.config.enabled) return store.findOrder(orderId);
  if (mp.inflight.has(orderId)) return mp.inflight.get(orderId);
  const job = attachInner(store, mp, orderId).finally(() => mp.inflight.delete(orderId));
  mp.inflight.set(orderId, job);
  return job;
}

async function attachInner(store, mp, orderId) {
  const prepared = await store.transaction(async tx => {
    const order = await tx.getOrder(orderId);
    if (!order) throw fail('Pedido não encontrado.', 404);
    if (order.mp_preference_id && order.mp_checkout_url) return { done: true, order };
    if (['Pago', 'Cancelado', 'Reembolsado', 'Contestado', 'Separando', 'Enviado', 'Entregue'].includes(order.status)) return { done: true, order };
    if (!order.mp_idempotency_key) await tx.saveOrder(order.id, { mp_idempotency_key: crypto.randomUUID() });
    return { done: false, order: await tx.getOrder(orderId) };
  });
  if (prepared.done) return prepared.order;
  const preference = buildPreference(prepared.order, mp.config);
  const created = await mp.createPreference(preference, prepared.order.mp_idempotency_key);
  const url = checkoutUrl(created, mp.config.mode);
  if (created.collector_id == null || created.collector_id === '') throw fail('Preferência sem recebedor.', 502);
  if (mp.config.collector && String(created.collector_id) !== mp.config.collector) throw fail('Recebedor da preferência não confere.', 502);
  if (!created.id) throw fail('Preferência sem identificador.', 502);
  const echoed = preferenceTotalCents(created);
  if (echoed !== null && echoed !== toCents(prepared.order.total)) throw fail('Total da preferência não confere com o pedido.', 502);
  return store.transaction(async tx => {
    const order = await tx.getOrder(orderId);
    if (order.mp_preference_id && order.mp_checkout_url) return order;
    await tx.saveOrder(order.id, {
      mp_preference_id: String(created.id),
      mp_checkout_url: url,
      mp_collector_id: String(created.collector_id),
    });
    return tx.getOrder(orderId);
  });
}

async function syncOrder(store, mp, orderId) {
  const order = await store.findOrder(orderId);
  if (!order || !mp.config.enabled || !order.mp_preference_id) return order;
  const found = await mp.searchPayments(externalReference(order.id));
  const results = Array.isArray(found.results) ? found.results : [];
  let current = order;
  for (const payment of results) current = await applyPayment(store, order.id, payment, mp.config) || current;
  return current;
}

async function loadNotifiedPayments(mp, type, dataId) {
  if (type === 'merchant_order' || type === 'topic_merchant_order_wh') {
    const merchantOrder = await mp.getMerchantOrder(dataId);
    const ids = [...new Set((merchantOrder.payments || []).map(payment => (payment && typeof payment === 'object' ? payment.id : payment)))];
    const payments = [];
    for (const id of ids) if (id) payments.push(await mp.getPayment(id));
    return payments;
  }
  if (type === 'payment' || type === '') return [await mp.getPayment(dataId)];
  return [];
}

async function handleWebhook(store, mp, { query = {}, headers = {}, body = {} }) {
  if (!mp.config.enabled) return { status: 503, body: { erro: 'Pagamento online indisponível.' } };
  let signed;
  try {
    signed = verifyWebhookSignature({
      secret: mp.config.secret,
      xSignature: headers['x-signature'],
      xRequestId: headers['x-request-id'],
      dataId: query['data.id'],
      toleranceSeconds: mp.config.tolerance,
    });
  } catch {
    return { status: 401, body: { erro: 'Assinatura inválida.' } };
  }
  if (!signed.dataId || !signed.requestId) return { status: 401, body: { erro: 'Assinatura inválida.' } };
  let dataId;
  try { dataId = resourceId(signed.dataId); } catch { return { status: 401, body: { erro: 'Assinatura inválida.' } }; }
  const note = await store.recordNotification({ requestId: signed.requestId, dataId, ts: signed.ts });
  if (note.conflict) return { status: 401, body: { erro: 'Assinatura inválida.' } };
  const type = String(query.type || body.type || query.topic || body.topic || '');
  try {
    const payments = await loadNotifiedPayments(mp, type, dataId);
    for (const payment of payments) {
      const order = await store.findByReference(String(payment.external_reference || ''));
      if (order) await applyPayment(store, order.id, payment, mp.config);
    }
    return { status: 200, body: { ok: true } };
  } catch (error) {
    console.error('mp webhook', error.mpStatus || 'falha');
    return { status: 503, body: { erro: 'Tente novamente.' } };
  }
}

function canAccess(order, { user, requestKey }) {
  if (!order) return false;
  if (user && Number.isSafeInteger(user.id) && user.id > 0 && order.user_id === user.id) return true;
  if (requestKey && order.request_key && sameText(requestKey, order.request_key)) return true;
  return false;
}

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function publicOrder(order, { checkout = false } = {}) {
  if (!order) return null;
  const showLink = checkout && order.mp_checkout_url && ['Novo', 'Pendente', 'Recusado'].includes(order.status);
  return {
    id: order.id,
    total: Number(centsToDecimal(toCents(order.total))),
    status: order.status,
    payment: order.payment,
    mp_status: order.mp_status || null,
    installments: order.mp_installments || null,
    items: order.items,
    created_at: order.created_at,
    ...(showLink ? { checkout_url: order.mp_checkout_url } : {}),
  };
}

module.exports = { applyPayment, attachPreference, syncOrder, handleWebhook, canAccess, publicOrder };
