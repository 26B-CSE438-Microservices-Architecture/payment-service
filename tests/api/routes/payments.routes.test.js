const express = require('express');
const request = require('supertest');

// Mock dependencies before requiring routes
jest.mock('../../../src/lib/prisma', () => require('../../helpers/mockPrisma'));
jest.mock('../../../src/queue/publisher', () => require('../../helpers/mockPublisher'));

jest.mock('../../../src/config', () => ({
  skipAuth: true,
  jwtSecret: 'test-secret',
  nodeEnv: 'test',
  paymentProvider: 'mock',
  port: 3000,
}));

const errorHandler = require('../../../src/api/middleware/errorHandler');
const { router, setup } = require('../../../src/api/routes/payments');

describe('Payment Routes', () => {
  let app;
  let mockPaymentService;

  const fakePayment = {
    id: 'pay_123',
    idempotencyKey: 'idem-1',
    orderId: 'order-1',
    userId: 'user-1',
    amount: 15000,
    currency: 'TRY',
    method: 'card',
    status: 'AWAITING_FORM',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockPaymentService = {
      createPayment: jest.fn(),
      capturePayment: jest.fn(),
      cancelPayment: jest.fn(),
      completeCheckoutForm: jest.fn(),
      getPayment: jest.fn(),
      getPaymentsByOrder: jest.fn(),
      getRecentPayments: jest.fn(),
    };

    setup(mockPaymentService);

    app = express();
    app.use(express.json());
    app.use('/payments', router);
    app.use(errorHandler);
  });

  // ─── POST /payments ───────────────────────────────────────────────────

  describe('POST /payments', () => {
    it('returns 201 with { payment } on new payment creation', async () => {
      mockPaymentService.createPayment.mockResolvedValue({
        payment: fakePayment,
        duplicate: false,
      });

      const res = await request(app)
        .post('/payments')
        .set('X-User-Id', 'user-1')
        .set('Idempotency-Key', 'idem-1')
        .send({ orderId: 'order-1', amount: 15000 });

      expect(res.status).toBe(201);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.id).toBe('pay_123');
    });

    it('returns 200 with { payment } on duplicate (idempotent replay)', async () => {
      mockPaymentService.createPayment.mockResolvedValue({
        payment: fakePayment,
        duplicate: true,
      });

      const res = await request(app)
        .post('/payments')
        .set('X-User-Id', 'user-1')
        .set('Idempotency-Key', 'idem-1')
        .send({ orderId: 'order-1', amount: 15000 });

      expect(res.status).toBe(200);
      expect(res.body.payment).toBeDefined();
    });

    it('includes checkoutForm in response when present in service result', async () => {
      mockPaymentService.createPayment.mockResolvedValue({
        payment: fakePayment,
        duplicate: false,
        checkoutForm: {
          token: 'cf_tok_123',
          content: 'base64html',
          paymentPageUrl: 'https://pay.example.com',
        },
      });

      const res = await request(app)
        .post('/payments')
        .set('X-User-Id', 'user-1')
        .set('Idempotency-Key', 'idem-1')
        .send({ orderId: 'order-1', amount: 15000 });

      expect(res.status).toBe(201);
      expect(res.body.checkoutForm).toBeDefined();
      expect(res.body.checkoutForm.token).toBe('cf_tok_123');
    });

    it('returns 400 when Idempotency-Key header is missing', async () => {
      const res = await request(app)
        .post('/payments')
        .set('X-User-Id', 'user-1')
        .send({ orderId: 'order-1', amount: 15000 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('passes through errors to errorHandler', async () => {
      const err = new Error('Something broke');
      err.code = 'PAYMENT_NOT_FOUND';
      err.statusCode = 404;
      mockPaymentService.createPayment.mockRejectedValue(err);

      const res = await request(app)
        .post('/payments')
        .set('X-User-Id', 'user-1')
        .set('Idempotency-Key', 'idem-1')
        .send({ orderId: 'order-1', amount: 15000 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  // ─── POST /payments/:paymentId/capture ────────────────────────────────

  describe('POST /payments/:paymentId/capture', () => {
    it('returns 200 with { payment } on success', async () => {
      const capturedPayment = { ...fakePayment, status: 'CAPTURED' };
      mockPaymentService.capturePayment.mockResolvedValue({ payment: capturedPayment });

      const res = await request(app)
        .post('/payments/pay_123/capture')
        .set('X-User-Id', 'user-1')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.payment.status).toBe('CAPTURED');
    });

    it('forwards amount from request body to service', async () => {
      mockPaymentService.capturePayment.mockResolvedValue({ payment: fakePayment });

      await request(app)
        .post('/payments/pay_123/capture')
        .set('X-User-Id', 'user-1')
        .send({ amount: 15000 });

      expect(mockPaymentService.capturePayment).toHaveBeenCalledWith('pay_123', { amount: 15000 });
    });
  });

  // ─── POST /payments/:paymentId/cancel ─────────────────────────────────

  describe('POST /payments/:paymentId/cancel', () => {
    it('returns 200 with { payment } on success', async () => {
      const voidedPayment = { ...fakePayment, status: 'VOIDED' };
      mockPaymentService.cancelPayment.mockResolvedValue({ payment: voidedPayment });

      const res = await request(app)
        .post('/payments/pay_123/cancel')
        .set('X-User-Id', 'user-1')
        .send({ reason: 'test cancel' });

      expect(res.status).toBe(200);
      expect(res.body.payment.status).toBe('VOIDED');
    });

    it('forwards reason from request body to service', async () => {
      mockPaymentService.cancelPayment.mockResolvedValue({ payment: fakePayment });

      await request(app)
        .post('/payments/pay_123/cancel')
        .set('X-User-Id', 'user-1')
        .send({ reason: 'changed mind' });

      expect(mockPaymentService.cancelPayment).toHaveBeenCalledWith('pay_123', { reason: 'changed mind' });
    });
  });

  // ─── POST /payments/:paymentId/checkout-form/callback ─────────────────

  describe('POST /payments/:paymentId/checkout-form/callback', () => {
    it('returns 200 with { payment } on success', async () => {
      const authorizedPayment = { ...fakePayment, status: 'AUTHORIZED' };
      mockPaymentService.completeCheckoutForm.mockResolvedValue({ payment: authorizedPayment });

      const res = await request(app)
        .post('/payments/pay_123/checkout-form/callback')
        .send({ token: 'cf_tok_123' });

      expect(res.status).toBe(200);
      expect(res.body.payment.status).toBe('AUTHORIZED');
    });

    it('returns 400 with MISSING_FORM_TOKEN when token is missing from body', async () => {
      const res = await request(app)
        .post('/payments/pay_123/checkout-form/callback')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_FORM_TOKEN');
    });

    it('is publicly accessible (no auth middleware)', async () => {
      // Should NOT return 401 even without X-User-Id or Authorization header
      mockPaymentService.completeCheckoutForm.mockResolvedValue({
        payment: { ...fakePayment, status: 'AUTHORIZED' },
      });

      const res = await request(app)
        .post('/payments/pay_123/checkout-form/callback')
        .send({ token: 'cf_tok_123' });

      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /payments/:paymentId ─────────────────────────────────────────

  describe('GET /payments/:paymentId', () => {
    it('returns 200 with { payment }', async () => {
      mockPaymentService.getPayment.mockResolvedValue(fakePayment);

      const res = await request(app)
        .get('/payments/pay_123')
        .set('X-User-Id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.id).toBe('pay_123');
    });
  });

  // ─── GET /payments?orderId=X ──────────────────────────────────────────

  describe('GET /payments?orderId=X', () => {
    it('returns payments filtered by orderId', async () => {
      mockPaymentService.getPaymentsByOrder.mockResolvedValue([fakePayment]);

      const res = await request(app)
        .get('/payments?orderId=order-1')
        .set('X-User-Id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.payments).toHaveLength(1);
      expect(mockPaymentService.getPaymentsByOrder).toHaveBeenCalledWith('order-1');
    });
  });

  // ─── GET /payments (no query) ─────────────────────────────────────────

  describe('GET /payments (no query)', () => {
    it('returns recent payments', async () => {
      mockPaymentService.getRecentPayments.mockResolvedValue([fakePayment]);

      const res = await request(app)
        .get('/payments')
        .set('X-User-Id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.payments).toHaveLength(1);
      expect(mockPaymentService.getRecentPayments).toHaveBeenCalled();
    });
  });
});
