'use strict';

function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      const error = new Error('Valor inválido.');
      error.expose = true;
      error.status = 400;
      throw error;
    }
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6) {
      const error = new Error('Valor inválido.');
      error.expose = true;
      error.status = 400;
      throw error;
    }
    return cents;
  }
  const match = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    const error = new Error('Valor inválido.');
    error.expose = true;
    error.status = 400;
    throw error;
  }
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    const error = new Error('Valor inválido.');
    error.expose = true;
    error.status = 400;
    throw error;
  }
  return (cents / 100).toFixed(2);
}

module.exports = { toCents, centsToDecimal };
