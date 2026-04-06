const express = require('express');
const prisma = require('../../lib/prisma');
const publisher = require('../../queue/publisher');

const router = express.Router();

router.get('/', async (req, res) => {
  const checks = { db: false, rabbitmq: false };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {}

  checks.rabbitmq = publisher.isConnected();

  const healthy = checks.db && checks.rabbitmq;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
  });
});

module.exports = router;
