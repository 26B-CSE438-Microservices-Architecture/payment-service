const config = require('../config');
const MockProvider = require('./MockProvider');
const IyzicoProvider = require('./IyzicoProvider');

function createProvider() {
  if (config.paymentProvider === 'mock') return new MockProvider();
  if (config.paymentProvider === 'iyzico') return new IyzicoProvider();
  throw new Error(`Unknown provider: ${config.paymentProvider}`);
}

module.exports = { createProvider };
