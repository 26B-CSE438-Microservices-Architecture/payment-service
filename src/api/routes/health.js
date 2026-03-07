const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const checks = { db: false };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {}

  const healthy = checks.db;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
  });
});

module.exports = router;
