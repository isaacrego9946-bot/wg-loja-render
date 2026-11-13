'use strict';

const { externalReference } = require('../lib/mp');

const ORDER_FIELDS = ['mp_preference_id', 'mp_checkout_url', 'mp_collector_id', 'mp_idempotency_key', 'mp_status', 'mp_payment_id', 'mp_installments', 'mp_payment_method', 'stock_restored', 'status'];

function copy(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createMemoryStore({ variants = [] } = {}) {
  const stock = new Map(variants.map(variant => [variant.id, { ...variant }]));
  const orders = new Map();
  const payments = new Map();
  const notes = new Map();
  let nextId = 1;
  let tail = Promise.resolve();

  function transaction(fn) {
    const run = tail.then(() => fn(methods));
    tail = run.then(() => {}, () => {});
    return run;
  }

  const methods = {
    async lockRequest() {},
    async findRequest(userId, key) {
      for (const order of orders.values()) if (order.user_id === userId && order.request_key === key) return copy(order);
      return null;
    },
    async lockVariant(id) {
      const variant = stock.get(id);
      return variant ? { ...variant } : null;
    },
    async decrementVariant(id, qty) {
      stock.get(id).stock -= qty;
    },
    async insertOrder(row) {
      const order = {
        mp_preference_id: null, mp_checkout_url: null, mp_collector_id: null, mp_idempotency_key: null,
        mp_status: null, mp_payment_id: null, mp_installments: null, mp_payment_method: null, stock_restored: false,
        ...copy(row), id: nextId++, created_at: new Date().toISOString(),
      };
      orders.set(order.id, order);
      return copy(order);
    },
    async getOrder(id) {
      return copy(orders.get(Number(id)));
    },
    async saveOrder(id, fields) {
      const order = orders.get(Number(id));
      if (!order) return null;
      for (const key of ORDER_FIELDS) if (Object.prototype.hasOwnProperty.call(fields, key)) order[key] = fields[key];
      return copy(order);
    },
    async upsertPayment(row) {
      const existing = payments.get(row.payment_id);
      if (existing && existing.order_id !== row.order_id) return null;
      payments.set(row.payment_id, { ...row });
      return { ...row };
    },
    async listPayments(orderId) {
      return [...payments.values()].filter(row => row.order_id === orderId).map(row => ({ ...row }));
    },
    async restoreStock(order) {
      const current = orders.get(order.id);
      if (!current || current.stock_restored) return;
      for (const item of current.items) {
        const variant = stock.get(item.variant_id);
        if (variant) variant.stock += item.qty;
      }
      current.stock_restored = true;
    },
  };

  return {
    transaction,
    findOrder: id => methods.getOrder(id),
    async findByReference(reference) {
      const match = /^wg-order-(\d+)$/.exec(String(reference || ''));
      if (!match) return null;
      const order = await methods.getOrder(Number(match[1]));
      return order && externalReference(order.id) === reference ? order : null;
    },
    async listMine(userId) {
      return [...orders.values()].filter(order => order.user_id === userId).sort((a, b) => b.id - a.id).map(copy);
    },
    async listAdmin() {
      return [...orders.values()].sort((a, b) => b.id - a.id).slice(0, 200).map(copy);
    },
    setStatus(id, status) {
      return transaction(async tx => {
        const order = await tx.getOrder(id);
        if (!order) return null;
        await tx.saveOrder(id, { status });
        if (status === 'Cancelado' && ['Novo', 'Pendente', 'Recusado', 'Pago'].includes(order.status)) await tx.restoreStock(order);
        return tx.getOrder(id);
      });
    },
    async recordNotification({ requestId, dataId, ts }) {
      const existing = notes.get(requestId);
      if (!existing) {
        notes.set(requestId, { requestId, dataId, ts });
        return { conflict: false, duplicate: false };
      }
      return { conflict: existing.dataId !== dataId, duplicate: true };
    },
    stockOf(id) {
      return stock.get(id)?.stock;
    },
  };
}

module.exports = { createMemoryStore };
