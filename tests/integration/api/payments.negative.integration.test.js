const request = require('supertest');
const express = require('express');
const prisma = require('../../../src/lib/prisma');
const publisher = require('../../../src/queue/publisher');
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

describe('Payment API Integration (Negative + Edge)', () => {
  it('returns 401 when X-User-Id header is missing in SKIP_AUTH mode', async () => {
    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'neg-idem-1')
      .send({ orderId: 'ord-neg-1', amount: 1000 });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 when Idempotency-Key is missing', async () => {
    const res = await request(app)
      .post('/payments')
      .set('X-User-Id', 'usr-neg-1')
      .send({ orderId: 'ord-neg-2', amount: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('returns 400 with MISSING_FORM_TOKEN when callback token is absent', async () => {
    const paymentId = 'pay-neg-callback-missing-token';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-neg-callback-token',
        orderId: 'ord-neg-callback-token',
        userId: 'usr-neg-2',
        amount: 2000,
        status: 'AWAITING_FORM',
        provider: 'mock',
      },
    });

    const res = await request(app)
      .post(`/payments/${paymentId}/checkout-form/callback`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_FORM_TOKEN');
  });

  it('transitions AWAITING_FORM to FAILED on invalid callback token', async () => {
    const createRes = await request(app)
      .post('/payments')
      .set('X-User-Id', 'usr-neg-3')
      .set('Idempotency-Key', 'idem-neg-invalid-token')
      .send({ orderId: 'ord-neg-invalid-token', amount: 3000 });

    expect(createRes.status).toBe(201);
    const paymentId = createRes.body.payment.id;

    const callbackRes = await request(app)
      .post(`/payments/${paymentId}/checkout-form/callback`)
      .send({ token: 'non-existent-token' });

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body.payment.status).toBe('FAILED');

    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(dbPayment.status).toBe('FAILED');

    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.failed',
      expect.objectContaining({ status: 'FAILED' })
    );
  });

  it('returns 409 INVALID_STATE_TRANSITION when capturing from CREATED', async () => {
    const paymentId = 'pay-neg-capture-created';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-neg-capture-created',
        orderId: 'ord-neg-capture-created',
        userId: 'usr-neg-4',
        amount: 5000,
        status: 'CREATED',
        provider: 'mock',
      },
    });

    const res = await request(app)
      .post(`/payments/${paymentId}/capture`)
      .set('X-User-Id', 'usr-neg-4')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('returns 400 AMOUNT_MISMATCH on partial capture attempt', async () => {
    const paymentId = 'pay-neg-capture-mismatch';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-neg-capture-mismatch',
        orderId: 'ord-neg-capture-mismatch',
        userId: 'usr-neg-5',
        amount: 9000,
        status: 'AUTHORIZED',
        provider: 'mock',
        providerTxId: 'mock-tx-capture-ok',
      },
    });

    const res = await request(app)
      .post(`/payments/${paymentId}/capture`)
      .set('X-User-Id', 'usr-neg-5')
      .send({ amount: 8000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AMOUNT_MISMATCH');
  });

  it('returns 409 INVALID_STATE_TRANSITION when canceling from FAILED', async () => {
    const paymentId = 'pay-neg-cancel-failed';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-neg-cancel-failed',
        orderId: 'ord-neg-cancel-failed',
        userId: 'usr-neg-6',
        amount: 7000,
        status: 'FAILED',
        provider: 'mock',
      },
    });

    const res = await request(app)
      .post(`/payments/${paymentId}/cancel`)
      .set('X-User-Id', 'usr-neg-6')
      .send({ reason: 'should-not-work' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refunds CAPTURED payment and transitions to REFUNDED', async () => {
    const paymentId = 'pay-neg-refund-captured';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-neg-refund-captured',
        orderId: 'ord-neg-refund-captured',
        userId: 'usr-neg-7',
        amount: 12000,
        status: 'CAPTURED',
        provider: 'mock',
        providerTxId: 'mock-tx-refund-ok',
      },
    });

    const res = await request(app)
      .post(`/payments/${paymentId}/cancel`)
      .set('X-User-Id', 'usr-neg-7')
      .send({ reason: 'customer requested refund' });

    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('REFUNDED');

    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(dbPayment.status).toBe('REFUNDED');
    expect(dbPayment.cancelReason).toBe('customer requested refund');

    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.refunded',
      expect.objectContaining({ status: 'REFUNDED' })
    );
  });
});