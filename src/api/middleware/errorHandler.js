const config = require('../../config');

const CODE_TO_STATUS = {
  PAYMENT_NOT_FOUND: 404,
  INVALID_STATE_TRANSITION: 409,
  CONCURRENT_MODIFICATION: 409,
  AMOUNT_MISMATCH: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  UNAUTHORIZED: 401,
  CARD_NOT_FOUND: 404,
  CARD_NOT_OWNED: 403,
  CARD_SAVE_FAILED: 502,
  MISSING_CARD_DETAILS: 400,
  CHECKOUT_FORM_INIT_FAILED: 502,
  CHECKOUT_FORM_RETRIEVE_FAILED: 502,
  MISSING_FORM_TOKEN: 400,
  CARD_STORAGE_INIT_FAILED: 502,
  CARD_STORAGE_RETRIEVE_FAILED: 502,
};

function errorHandler(err, req, res, _next) {
  if (config.nodeEnv === 'development') {
    console.error('Error:', err);
  }

  const code = err.code || 'INTERNAL_ERROR';
  const status = err.statusCode || CODE_TO_STATUS[code] || 500;
  const message = status === 500 ? 'Internal server error' : err.message;

  res.status(status).json({
    error: { code, message },
  });
}

module.exports = errorHandler;
