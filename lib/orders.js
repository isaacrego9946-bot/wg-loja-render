'use strict';

const crypto = require('crypto');
const { toCents, centsToDecimal } = require('./money');

function fail(message) {
  const error = new Error(message);
  error.expose = true;
  error.status = 400;
  return error;
}

function frete(cep) {
  return String(cep).replace(/\D/g, '').startsWith('14') ? { entrega: 15, retirada: 0 } : { entrega: 30, retirada: 0 };
}

function requestHash(body) {
  const { items, address, cep, delivery, payment, phone, customer_name: customerName } = body;
  return crypto.createHash('sha256').update(JSON.stringify({ items, address, cep, delivery, payment, phone, customer_name: customerName })).digest('hex');
}

function assertCheckout(body) {
  const name = String(body.customer_name || '').trim();
  const phone = String(body.phone || '').replace(/\D/g, '');
  if (name.length < 2 || name.length > 100 || !/^\d{10,13}$/.test(phone)) throw fail('Informe seu nome e telefone com DDD.');
  if (!['entrega', 'retirada'].includes(body.delivery) || !['pix', 'cartao'].includes(body.payment)) throw fail('Escolha entrega e pagamento.');
  if (body.delivery === 'entrega' && (String(body.address || '').trim().length < 5 || String(body.cep || '').replace(/\D/g, '').length !== 8)) throw fail('Informe o endereço completo e um CEP com 8 dígitos.');
  const { items } = body;
  if (!Array.isArray(items) || !items.length || items.length > 100 || items.some(item => !item || !Number.isSafeInteger(item.variant_id) || item.variant_id <= 0 || !Number.isSafeInteger(item.qty) || item.qty <= 0)) {
    throw fail('Informe itens e quantidades inteiras maiores que zero.');
  }
  return { name, phone };
}

async function createOrder(store, { user, body }) {
  const { name, phone } = assertCheckout(body);
  if (body.request_key !== undefined && !/^[a-f0-9-]{36}$/i.test(body.request_key)) throw fail('Identificador de pedido inválido');
  const hash = requestHash(body);
  try {
    return await store.transaction(async tx => {
      if (body.request_key) {
        await tx.lockRequest(user.id, body.request_key);
        const previous = await tx.findRequest(user.id, body.request_key);
        if (previous) {
          if (previous.request_hash !== hash) throw fail('O pedido anterior já foi enviado com outros dados. Atualize a página.');
          return previous;
        }
      }
      let sub = 0;
      const list = [];
      for (const item of [...body.items].sort((a, b) => a.variant_id - b.variant_id)) {
        const variant = await tx.lockVariant(item.variant_id);
        if (!variant || variant.stock < item.qty) throw fail(variant ? `Estoque insuficiente: ${variant.name} (${variant.size}/${variant.color}). Disponível: ${variant.stock}` : 'Produto indisponível.');
        await tx.decrementVariant(variant.id, item.qty);
        const cents = toCents(variant.price);
        sub += cents * item.qty;
        list.push({ variant_id: variant.id, product_id: variant.product_id, name: variant.name, size: variant.size, color: variant.color, qty: item.qty, price: Number(centsToDecimal(cents)) });
      }
      const ship = body.delivery === 'retirada' ? 0 : toCents(frete(body.cep).entrega);
      return tx.insertOrder({
        user_id: user.id,
        customer: { name: String(body.customer_name || user.name || name).trim().slice(0, 100), phone, address: body.address, cep: body.cep, delivery: body.delivery },
        items: list,
        shipping: centsToDecimal(ship),
        total: centsToDecimal(sub + ship),
        payment: body.payment,
        request_key: body.request_key || null,
        request_hash: hash,
        status: 'Novo',
      });
    });
  } catch (error) {
    if (error.expose) throw error;
    if (error.code === '23505') throw fail('Não foi possível confirmar o pedido. Atualize a página e tente novamente.');
    throw error;
  }
}

module.exports = { frete, createOrder, assertCheckout };
