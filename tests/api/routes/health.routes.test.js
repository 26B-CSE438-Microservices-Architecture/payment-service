const express = require('express');
const request = require('supertest');

jest.mock('../../../src/lib/prisma', () => require('../../helpers/mockPrisma'));
jest.mock('../../../src/queue/publisher', () => require('../../helpers/mockPublisher'));

const prisma = require('../../../src/lib/prisma');
const publisher = require('../../../src/queue/publisher');
const healthRouter = require('../../../src/api/routes/health');

describe('Health Routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/health', healthRouter);
  });

  it('returns 200 { status: "ok", checks: { db: true, rabbitmq: true } } when both are healthy', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    publisher.isConnected.mockReturnValue(true);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      checks: { db: true, rabbitmq: true },
    });
  });

  it('returns 503 { status: "degraded" } when DB is down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('DB connection failed'));
    publisher.isConnected.mockReturnValue(true);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.db).toBe(false);
    expect(res.body.checks.rabbitmq).toBe(true);
  });

  it('returns 503 when RabbitMQ is disconnected', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    publisher.isConnected.mockReturnValue(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.db).toBe(true);
    expect(res.body.checks.rabbitmq).toBe(false);
  });

  it('returns 503 when both DB and RabbitMQ are down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('DB connection failed'));
    publisher.isConnected.mockReturnValue(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.db).toBe(false);
    expect(res.body.checks.rabbitmq).toBe(false);
  });
});
