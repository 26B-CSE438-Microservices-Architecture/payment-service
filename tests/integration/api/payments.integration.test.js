const request = require('supertest');
const express = require('express');
const prisma = require('../../../src/lib/prisma');
const publisher = require('../../../src/queue/publisher'); // mocked via setupEnv.js
const { createProvider } = require('../../../src/providers');
const PaymentService = require('../../../src/core/PaymentService');
const { router, setup } = require('../../../src/api/routes/payments');
const errorHandler = require('../../../src/api/middleware/errorHandler');

let app;

beforeAll(() => {
  // Configured with MOCK provider (via setupEnv process.env.PAYMENT_PROVIDER)
  const provider = createProvider();
  const paymentService = new PaymentService(provider);
  setup(paymentService);

  app = express();
  app.use(express.json());
  app.use('/payments', router);
  app.use(errorHandler);
});

afterEach(async () => {
  // Clean up real test DB after each scenario
  await prisma.paymentEvent.deleteMany({});
  await prisma.payment.deleteMany({});
  jest.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /payments (Integration)', () => {
  it('should successfully create a payment in Postgres and return 201', async () => {
    const orderId = 'ord-integration-1';
    
    const res = await request(app)
      .post('/payments')
      .set('X-User-Id', 'usr-test-1')
      .set('Idempotency-Key', 'idempotent-key-123')
      .send({ orderId, amount: 20000 }); // 200.00 TRY

    expect(res.status).toBe(201);
    expect(res.body.payment).toBeDefined();
    
    // Verify DB
    const dbPayment = await prisma.payment.findUnique({
      where: { id: res.body.payment.id }
    });
    
    expect(dbPayment).not.toBeNull();
    expect(dbPayment.orderId).toBe(orderId);
    expect(dbPayment.status).toBe('AWAITING_FORM');
    // For mock provider, we expect checkoutForm token
    expect(res.body.checkoutForm.token).toBeDefined();
  });

  it('should be idempotent and not create duplicates in DB', async () => {
    const payload = { orderId: 'ord-integration-2', amount: 15000 };
    const idemKey = 'idempotent-key-456';
    const userId = 'usr-test-2';

    // 1st request
    const res1 = await request(app)
      .post('/payments')
      .set('X-User-Id', userId)
      .set('Idempotency-Key', idemKey)
      .send(payload);

    expect(res1.status).toBe(201);
    const paymentId = res1.body.payment.id;

    // 2nd Request with same key
    const res2 = await request(app)
      .post('/payments')
      .set('X-User-Id', userId)
      .set('Idempotency-Key', idemKey)
      .send(payload);

    // Should return 200 instead of 201
    expect(res2.status).toBe(200);
    expect(res2.body.payment.id).toBe(paymentId);

    // Ensure DB still only has 1 record
    const count = await prisma.payment.count({ where: { idempotencyKey: idemKey } });
    expect(count).toBe(1);
  });

  it('should update payment status and publish event on checkout callback', async () => {
    // 1. Create payment first
    const res = await request(app)
      .post('/payments')
      .set('X-User-Id', 'usr-test-3')
      .set('Idempotency-Key', 'idempotent-key-789')
      .send({ orderId: 'ord-integration-3', amount: 30000 });

    const paymentId = res.body.payment.id;
    const token = res.body.checkoutForm.token; // Mock provider token

    // 2. Hit callback endpoint
    const callbackRes = await request(app)
      .post(`/payments/${paymentId}/checkout-form/callback`)
      .send({ token });

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body.payment.status).toBe('AUTHORIZED');

    // 3. Verify DB Update
    const dbPayment = await prisma.payment.findUnique({
      where: { id: paymentId }
    });
    expect(dbPayment.status).toBe('AUTHORIZED');

    // 4. Verify PaymentEvent created in DB
    const events = await prisma.paymentEvent.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'desc' }
    });
    // AWAITING_FORM -> AUTHORIZED event
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].toStatus).toBe('AUTHORIZED');

    // 5. Verify RabbitMQ publisher mock was called with correct data
    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.authorized',
      expect.objectContaining({ status: 'AUTHORIZED' })
    );
  });

  // --- CAPTURE ENDPOINT ---
  it('should capture an AUTHORIZED payment', async () => {
    // 1. Setup: Create an implicitly AUTHORIZED payment
    const paymentId = 'pay-capture-test';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-capture-1',
        orderId: 'ord-capture-1',
        userId: 'usr-1',
        amount: 5000,
        status: 'AUTHORIZED', // simulate already authorized status
        provider: 'mock',
        providerTxId: 'mock-tx-capture',
      }
    });

    // 2. Execute
    const res = await request(app)
      .post(`/payments/${paymentId}/capture`)
      .set('X-User-Id', 'usr-1')
      .send();

    // 3. Verify Response
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('CAPTURED');

    // 4. Verify DB
    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(dbPayment.status).toBe('CAPTURED');
    
    // 5. Verify Message Queue Event
    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.captured',
      expect.objectContaining({ status: 'CAPTURED' })
    );
  });

  // --- CANCEL ENDPOINT (VOID / REFUND) ---
  it('should void an test payment if it is in AUTHORIZED status', async () => {
    const paymentId = 'pay-void-test';
    await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey: 'idem-void-1',
        orderId: 'ord-void-1',
        userId: 'usr-1',
        amount: 5000,
        status: 'AUTHORIZED',
        provider: 'mock',
        providerTxId: 'mock-tx-void',
      }
    });

    const res = await request(app)
      .post(`/payments/${paymentId}/cancel`)
      .set('X-User-Id', 'usr-1')
      .send({ reason: 'customer explicit cancellation request' });

    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('VOIDED');

    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(dbPayment.status).toBe('VOIDED');
    expect(dbPayment.cancelReason).toBe('customer explicit cancellation request');
    
    expect(publisher.publish).toHaveBeenCalledWith(
      'payment.voided',
      expect.objectContaining({ status: 'VOIDED' })
    );
  });

  // --- GET ENDPOINTS ---
  it('should return 404 for fetching a non-existent payment', async () => {
    const res = await request(app)
      .get('/payments/non-existent-random-id')
      .set('X-User-Id', 'usr-1');

    expect(res.status).toBe(404);
  });

  it('should fetch payments filtered by orderId from the database', async () => {
    await prisma.payment.create({
      data: {
        id: 'pay-fetch-by-order',
        idempotencyKey: 'idem-fetch-1',
        orderId: 'ord-target-fetch-id',
        userId: 'usr-1',
        amount: 2000,
        status: 'CREATED',
        provider: 'mock',
      }
    });

    const res = await request(app)
      .get('/payments?orderId=ord-target-fetch-id')
      .set('X-User-Id', 'usr-1');

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0].id).toBe('pay-fetch-by-order');
    expect(res.body.payments[0].orderId).toBe('ord-target-fetch-id');
  });
});
