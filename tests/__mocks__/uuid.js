/**
 * CJS-compatible mock for the `uuid` module (v13+ is ESM-only).
 * Provides a working v4 implementation using Node's built-in crypto.
 */
const crypto = require('crypto');

function v4() {
  return crypto.randomUUID();
}

module.exports = { v4 };
