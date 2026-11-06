'use strict';

const { externalReference } = require('./mp');

const ORDER_FIELDS = ['mp_preference_id', 'mp_checkout_url', 'mp_collector_id', 'mp_idempotency_key', 'mp_status', 'mp_payment_id', 'mp_installments', 'mp_payment_method', 'stock_restored', 'status'];

function hydrate(row) {
  if (!row) return null;
  const order = { ...row };
  if (typeof order.items === 'string') order.items = JSON.parse(order.items);
  if (typeof order.customer === 'string') order.customer = JSON.parse(order.customer);
  order.stock_restored = order.stock_restored === true;
  return order;
}

function createPgStore(db) {
  function tx(client) {
    return {
      lockRequest: (userId, key) => client.query('select pg_advisory_xact_lock($1, hashtext($2))', [userId, key]),
      async findRequest(userId, key) {
        const result = await client.query('select * from orders where user_id=$1 and request_key=$2', [userId, key]);
        return hydrate(result.rows[0]);
      },
      async lockVariant(id) {
        const result = await client.query('select v.*, p.name, p.price from variants v join products p on p.id=v.product_id where v.id=$1 for update', [id]);
        return result.rows[0] || null;
      },
      decrementVariant: (id, qty) => client.query('update variants set stock=stock-$1 where id=$2', [qty, id]),
      async insertOrder(row) {
        const result = await client.query(`insert into orders(user_id,customer,items,shipping,total,payment,request_key,request_hash,status)
          values ($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8,$9) returning *`,
        [row.user_id, JSON.stringify(row.customer), JSON.stringify(row.items), row.shipping, row.total, row.payment, row.request_key, row.request_hash, row.status]);
        return hydrate(result.rows[0]);
      },
      async getOrder(id) {
        const result = await client.query('select * from orders where id=$1 for update', [id]);
        return hydrate(result.rows[0]);
      },
      async saveOrder(id, fields) {
        const keys = ORDER_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(fields, key));
        if (!keys.length) return hydrate((await client.query('select * from orders where id=$1', [id])).rows[0]);
        const values = keys.map(key => fields[key]);
        const result = await client.query(`update orders set ${keys.map((key, index) => `${key}=$${index + 2}`).join(',')} where id=$1 returning *`, [id, ...values]);
        return hydrate(result.rows[0]);
      },
      async upsertPayment(row) {
        const existing = await client.query('select order_id from mp_payments where payment_id=$1', [row.payment_id]);
        if (existing.rows[0] && Number(existing.rows[0].order_id) !== Number(row.order_id)) return null;
        await client.query(`insert into mp_payments(payment_id,order_id,status,amount_cents,currency,live_mode,installments,payment_method,payment_type,accepted,updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
          on conflict (payment_id) do update set status=excluded.status, amount_cents=excluded.amount_cents, currency=excluded.currency,
            live_mode=excluded.live_mode, installments=excluded.installments, payment_method=excluded.payment_method,
            payment_type=excluded.payment_type, accepted=excluded.accepted, updated_at=now()
          where mp_payments.order_id=excluded.order_id`,
        [row.payment_id, row.order_id, row.status, row.amount_cents, row.currency, row.live_mode, row.installments, row.payment_method, row.payment_type, row.accepted]);
        return row;
      },
      async listPayments(orderId) {
        const result = await client.query('select * from mp_payments where order_id=$1 order by updated_at, payment_id', [orderId]);
        return result.rows;
      },
      async restoreStock(order) {
        const current = hydrate((await client.query('select * from orders where id=$1 for update', [order.id])).rows[0]);
        if (!current || current.stock_restored) return;
        for (const item of current.items || []) {
          if (Number.isSafeInteger(item.variant_id) && Number.isSafeInteger(item.qty) && item.qty > 0) {
            await client.query('update variants set stock=stock+$1 where id=$2', [item.qty, item.variant_id]);
          }
        }
        await client.query('update orders set stock_restored=true where id=$1', [order.id]);
      },
    };
  }

  const store = {
    async transaction(fn) {
      const client = await db.connect();
      try {
        await client.query('begin');
        const result = await fn(tx(client));
        await client.query('commit');
        return result;
      } catch (error) {
        try { await client.query('rollback'); } catch { /* a conexão já pode ter caído */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async findOrder(id) {
      const result = await db.query('select * from orders where id=$1', [id]);
      return hydrate(result.rows[0]);
    },
    async findByReference(reference) {
      const match = /^wg-order-(\d+)$/.exec(String(reference || ''));
      if (!match) return null;
      const order = await store.findOrder(Number(match[1]));
      return order && externalReference(order.id) === reference ? order : null;
    },
    async listMine(userId) {
      const result = await db.query('select * from orders where user_id=$1 order by id desc', [userId]);
      return result.rows.map(hydrate);
    },
    async listAdmin() {
      const result = await db.query('select * from orders order by id desc limit 200');
      return result.rows.map(hydrate);
    },
    async setStatus(id, status) {
      return store.transaction(async client => {
        const order = await client.getOrder(id);
        if (!order) return null;
        await client.saveOrder(id, { status });
        if (status === 'Cancelado' && ['Novo', 'Pendente', 'Recusado', 'Pago'].includes(order.status)) await client.restoreStock(order);
        return client.getOrder(id);
      });
    },
    async recordNotification({ requestId, dataId, ts }) {
      const inserted = await db.query('insert into mp_notifications(request_id, data_id, ts) values ($1,$2,$3) on conflict (request_id) do nothing returning request_id', [requestId, dataId, ts]);
      if (inserted.rows.length) return { conflict: false, duplicate: false };
      const current = await db.query('select data_id from mp_notifications where request_id=$1', [requestId]);
      if (current.rows[0] && current.rows[0].data_id !== dataId) return { conflict: true, duplicate: true };
      return { conflict: false, duplicate: true };
    },
  };
  return store;
}

module.exports = { createPgStore };
