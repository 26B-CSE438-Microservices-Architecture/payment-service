const request = require('supertest');
const express = require('express');
const prisma = require('../../../src/lib/prisma');
const { createProvider } = require('../../../src/providers');
const PaymentService = require('../../../src/core/PaymentService');
const { router, setup } = require('../../../src/api/routes/payments');
const errorHandler = require('../../../src/api/middleware/errorHandler');

let app;

beforeAll(() => {
  const provider = createProvider();
  const paymentService = new PaymentService(provider);
  setup(paymentService);

  app = express();
  app.use(express.json());
  app.use('/payments', router);
  app.use(errorHandler);
});

afterEach(async () => {
  await prisma.paymentEvent.deleteMany({});
  await prisma.payment.deleteMany({});
  jest.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Payment API Integration (Concurrency)', () => {
  it('handles two concurrent create requests with same idempotency key without duplicates', async () => {
    const payload = { orderId: 'ord-concurrency-1', amount: 18000 };
    const idemKey = 'idem-concurrency-key-1';
    const userId = 'usr-concurrency-1';

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/payments')
        .set('X-User-Id', userId)
        .set('Idempotency-Key', idemKey)
        .send(payload),
      request(app)
        .post('/payments')
        .set('X-User-Id', userId)
        .set('Idempotency-Key', idemKey)
        .send(payload),
    ]);

    // One request should create (201), the other should replay (200).
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 201]);

    expect(resA.body.payment).toBeDefined();
    expect(resB.body.payment).toBeDefined();
    expect(resA.body.payment.id).toBe(resB.body.payment.id);

    const count = await prisma.payment.count({ where: { idempotencyKey: idemKey } });
    expect(count).toBe(1);
  });
});