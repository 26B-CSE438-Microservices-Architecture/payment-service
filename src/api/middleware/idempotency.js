const prisma = require('../../lib/prisma');

function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    return res.status(400).json({
      error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' },
    });
  }

  req.idempotencyKey = idempotencyKey;
  next();
}

module.exports = idempotencyMiddleware;
