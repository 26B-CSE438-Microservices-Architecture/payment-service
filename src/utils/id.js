const { v4: uuidv4 } = require('uuid');

function generatePaymentId() {
  return `pay_${uuidv4()}`;
}

function generateCardId() {
  return `card_${uuidv4()}`;
}

module.exports = { generatePaymentId, generateCardId };
