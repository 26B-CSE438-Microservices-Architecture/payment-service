jest.mock('../../src/lib/prisma', () => require('../helpers/mockPrisma'));
jest.mock('../../src/queue/publisher', () => require('../helpers/mockPublisher'));
jest.mock('../../src/utils/id', () => ({
  generatePaymentId: jest.fn().mockReturnValue('pay_test-uuid-1234'),
}));

const prisma = require('../../src/lib/prisma');
const publisher = require('../../src/queue/publisher');
const PaymentService = require('../../src/core/PaymentService');

describe('PaymentService', () => {
  let service;
  let mockProvider;

  const baseFakePayment = {
    id: 'pay_test-uuid-1234',
    idempotencyKey: 'idem-key-1',
    orderId: 'order-1',
    userId: 'user-1',
    amount: 15000,
    currency: 'TRY',
    method: 'card',
    status: 'CREATED',
    provider: 'mock',
    metadata: null,
    events: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      initCheckoutForm: jest.fn(),
      retrieveCheckoutForm: jest.fn(),
      capture: jest.fn(),
      void: jest.fn(),
      refund: jest.fn(),
    };

    service = new PaymentService(mockProvider);
  });

  // ─── createPayment ────────────────────────────────────────────────────

  describe('createPayment()', () => {
    const createArgs = {
      idempotencyKey: 'idem-key-1',
      orderId: 'order-1',
      userId: 'user-1',
      amount: 15000,
    };

    it('returns existing payment with duplicate: true when idempotencyKey already exists', async () => {
      const existingPayment = { ...baseFakePayment, status: 'AWAITING_FORM' };
      prisma.payment.findUnique.mockResolvedValue(existingPayment);

      const result = await service.createPayment(createArgs);

      expect(result.payment).toEqual(existingPayment);
      expect(result.duplicate).toBe(true);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('voids a previous AUTHORIZED payment for the same orderId before creating a new one', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null); // no idempotency match
      const previousAuth = { ...baseFakePayment, id: 'pay_old', status: 'AUTHORIZED', providerTxId: 'mock_tx_old' };
      prisma.payment.findFirst.mockResolvedValue(previousAuth);
      mockProvider.void.mockResolvedValue({ success: true });
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...previousAuth, status: 'VOIDED' }); // _transitionPayment re-fetch for void

      // Create new payment
      const createdPayment = { ...baseFakePayment };
      prisma.payment.create.mockResolvedValue(createdPayment);

      // initCheckoutForm succeeds
      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'cf_tok_123',
        content: 'base64html',
        paymentPageUrl: null,
      });

      // Transition CREATED → AWAITING_FORM
      const updatedPayment = { ...baseFakePayment, status: 'AWAITING_FORM', metadata: { checkoutFormToken: 'cf_tok_123' } };
      prisma.payment.findUnique.mockResolvedValueOnce(updatedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.createPayment(createArgs);

      expect(mockProvider.void).toHaveBeenCalledWith({ providerTxId: 'mock_tx_old' });
    });

    it('creates a payment with status CREATED then transitions to AWAITING_FORM on successful checkout form init', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null); // no idempotency match
      prisma.payment.findFirst.mockResolvedValue(null); // no previous auth

      const createdPayment = { ...baseFakePayment, status: 'CREATED' };
      prisma.payment.create.mockResolvedValue(createdPayment);

      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'cf_tok_123',
        content: 'base64html',
        paymentPageUrl: 'https://pay.example.com',
      });

      const updatedPayment = { ...baseFakePayment, status: 'AWAITING_FORM' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(updatedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.createPayment(createArgs);

      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CREATED' }),
        }),
      );
      expect(result.payment.status).toBe('AWAITING_FORM');
    });

    it('returns checkoutForm object with token, content, paymentPageUrl', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ ...baseFakePayment });

      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'cf_tok_123',
        content: 'base64html',
        paymentPageUrl: 'https://pay.example.com',
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...baseFakePayment, status: 'AWAITING_FORM' });
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.createPayment(createArgs);

      expect(result.checkoutForm).toEqual({
        token: 'cf_tok_123',
        content: 'base64html',
        paymentPageUrl: 'https://pay.example.com',
      });
    });

    it('transitions to FAILED and publishes payment.failed when provider.initCheckoutForm() throws', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ ...baseFakePayment });

      mockProvider.initCheckoutForm.mockRejectedValue(new Error('Provider down'));

      const failedPayment = { ...baseFakePayment, status: 'FAILED', failureReason: 'Provider down' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(failedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.createPayment(createArgs);

      expect(result.payment.status).toBe('FAILED');
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({ paymentId: 'pay_test-uuid-1234', status: 'FAILED' }),
      );
    });

    it('logs a PaymentEvent for CREATED→AWAITING_FORM transition', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ ...baseFakePayment });

      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'cf_tok_123',
        content: 'base64html',
        paymentPageUrl: null,
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...baseFakePayment, status: 'AWAITING_FORM' });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.createPayment(createArgs);

      expect(prisma.paymentEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          paymentId: 'pay_test-uuid-1234',
          fromStatus: 'CREATED',
          toStatus: 'AWAITING_FORM',
          triggeredBy: 'system',
        }),
      });
    });

    it('uses default currency TRY and method card when not provided', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ ...baseFakePayment });

      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'cf_tok_123',
        content: 'base64html',
        paymentPageUrl: null,
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...baseFakePayment, status: 'AWAITING_FORM' });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.createPayment({ ...createArgs, currency: undefined, paymentMethod: undefined });

      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ currency: 'TRY', method: 'card' }),
        }),
      );
    });

    it('correctly replaces {paymentId} in the callback URL template', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ ...baseFakePayment });

      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'tok',
        content: 'html',
        paymentPageUrl: null,
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...baseFakePayment, status: 'AWAITING_FORM' });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.createPayment({
        ...createArgs,
        callbackUrl: 'https://example.com/payments/{paymentId}/callback',
      });

      expect(mockProvider.initCheckoutForm).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackUrl: `https://example.com/payments/${baseFakePayment.id}/callback`,
        }),
      );
    });

    it('falls back to localhost callback URL when no callbackUrl provided', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(null);
      prisma.payment.findFirst.mockResolvedValue(null);
      prisma.payment.create.mockResolvedValue({ ...baseFakePayment });

      mockProvider.initCheckoutForm.mockResolvedValue({
        token: 'tok',
        content: 'html',
        paymentPageUrl: null,
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...baseFakePayment, status: 'AWAITING_FORM' });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.createPayment(createArgs);

      expect(mockProvider.initCheckoutForm).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackUrl: expect.stringContaining(`/payments/${baseFakePayment.id}/checkout-form/callback`),
        }),
      );
    });
  });

  // ─── completeCheckoutForm ─────────────────────────────────────────────

  describe('completeCheckoutForm()', () => {
    const awaitingPayment = {
      ...baseFakePayment,
      status: 'AWAITING_FORM',
      metadata: { checkoutFormToken: 'cf_tok_123' },
    };

    it('transitions AWAITING_FORM→AUTHORIZED and publishes payment.authorized on provider success', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(awaitingPayment);

      mockProvider.retrieveCheckoutForm.mockResolvedValue({
        success: true,
        providerTxId: 'mock_tx_999',
        itemTransactions: [{ itemId: 'ITEM_1', paymentTransactionId: 'txn_1', price: '150.00' }],
      });

      const authorizedPayment = { ...baseFakePayment, status: 'AUTHORIZED', providerTxId: 'mock_tx_999' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.completeCheckoutForm('pay_test-uuid-1234', { token: 'cf_tok_123' });

      expect(result.payment.status).toBe('AUTHORIZED');
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.authorized',
        expect.objectContaining({ status: 'AUTHORIZED' }),
      );
    });

    it('saves providerTxId and itemTransactions in metadata, removes checkoutFormToken', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(awaitingPayment);

      mockProvider.retrieveCheckoutForm.mockResolvedValue({
        success: true,
        providerTxId: 'mock_tx_999',
        itemTransactions: [{ itemId: 'ITEM_1', paymentTransactionId: 'txn_1', price: '150.00' }],
      });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({
        ...baseFakePayment,
        status: 'AUTHORIZED',
        providerTxId: 'mock_tx_999',
      });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.completeCheckoutForm('pay_test-uuid-1234', { token: 'cf_tok_123' });

      // Verify updateMany was called with metadata containing itemTransactions and no checkoutFormToken
      const updateCall = prisma.payment.updateMany.mock.calls[0][0];
      expect(updateCall.data.providerTxId).toBe('mock_tx_999');
      expect(updateCall.data.metadata.itemTransactions).toEqual([
        { itemId: 'ITEM_1', paymentTransactionId: 'txn_1', price: '150.00' },
      ]);
      expect(updateCall.data.metadata.checkoutFormToken).toBeUndefined();
    });

    it('transitions AWAITING_FORM→FAILED and publishes payment.failed on provider failure', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(awaitingPayment);

      mockProvider.retrieveCheckoutForm.mockResolvedValue({
        success: false,
        failureReason: 'card_declined',
      });

      const failedPayment = { ...baseFakePayment, status: 'FAILED', failureReason: 'card_declined' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(failedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.completeCheckoutForm('pay_test-uuid-1234', { token: 'cf_tok_123' });

      expect(result.payment.status).toBe('FAILED');
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.failed',
        expect.objectContaining({ status: 'FAILED' }),
      );
    });

    it('throws INVALID_STATE_TRANSITION (409) if current status is not AWAITING_FORM', async () => {
      // Use CAPTURED status which truly cannot transition to AUTHORIZED
      // (CREATED→AUTHORIZED is actually valid in the FSM)
      const capturedPayment = { ...baseFakePayment, status: 'CAPTURED' };
      prisma.payment.findUnique.mockResolvedValueOnce(capturedPayment);

      await expect(
        service.completeCheckoutForm('pay_test-uuid-1234', { token: 'tok' }),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        statusCode: 409,
      });
    });
  });

  // ─── capturePayment ───────────────────────────────────────────────────

  describe('capturePayment()', () => {
    const authorizedPayment = {
      ...baseFakePayment,
      status: 'AUTHORIZED',
      providerTxId: 'mock_tx_999',
    };

    it('transitions AUTHORIZED→CAPTURED and publishes payment.captured', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);
      mockProvider.capture.mockResolvedValue({ success: true });

      const capturedPayment = { ...authorizedPayment, status: 'CAPTURED' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(capturedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.capturePayment('pay_test-uuid-1234');

      expect(result.payment.status).toBe('CAPTURED');
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.captured',
        expect.objectContaining({ status: 'CAPTURED' }),
      );
    });

    it('calls provider.capture() with the payment providerTxId, amount, currency', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);
      mockProvider.capture.mockResolvedValue({ success: true });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...authorizedPayment, status: 'CAPTURED' });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.capturePayment('pay_test-uuid-1234');

      expect(mockProvider.capture).toHaveBeenCalledWith({
        providerTxId: 'mock_tx_999',
        amount: 15000,
        currency: 'TRY',
      });
    });

    it('throws AMOUNT_MISMATCH (400) if amount is provided and does not match', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);

      await expect(
        service.capturePayment('pay_test-uuid-1234', { amount: 999 }),
      ).rejects.toMatchObject({
        code: 'AMOUNT_MISMATCH',
        statusCode: 400,
      });
    });

    it('throws INVALID_STATE_TRANSITION if status is not AUTHORIZED', async () => {
      const createdPayment = { ...baseFakePayment, status: 'CREATED' };
      prisma.payment.findUnique.mockResolvedValueOnce(createdPayment);

      await expect(
        service.capturePayment('pay_test-uuid-1234'),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
    });

    it('passes when amount is undefined (no partial capture check)', async () => {
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);
      mockProvider.capture.mockResolvedValue({ success: true });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...authorizedPayment, status: 'CAPTURED' });
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.capturePayment('pay_test-uuid-1234', {});

      expect(result.payment.status).toBe('CAPTURED');
    });
  });

  // ─── cancelPayment ────────────────────────────────────────────────────

  describe('cancelPayment()', () => {
    it('when AUTHORIZED: calls provider.void(), transitions to VOIDED, publishes payment.voided', async () => {
      const authorizedPayment = { ...baseFakePayment, status: 'AUTHORIZED', providerTxId: 'mock_tx_999' };
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);
      mockProvider.void.mockResolvedValue({ success: true });

      const voidedPayment = { ...authorizedPayment, status: 'VOIDED' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(voidedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.cancelPayment('pay_test-uuid-1234', { reason: 'user requested' });

      expect(mockProvider.void).toHaveBeenCalledWith({ providerTxId: 'mock_tx_999' });
      expect(result.payment.status).toBe('VOIDED');
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.voided',
        expect.objectContaining({ status: 'VOIDED' }),
      );
    });

    it('when CAPTURED: calls provider.refund(), transitions to REFUNDED, publishes payment.refunded', async () => {
      const capturedPayment = {
        ...baseFakePayment,
        status: 'CAPTURED',
        providerTxId: 'mock_tx_999',
        metadata: { itemTransactions: [] },
      };
      prisma.payment.findUnique.mockResolvedValueOnce(capturedPayment);
      mockProvider.refund.mockResolvedValue({ success: true });

      const refundedPayment = { ...capturedPayment, status: 'REFUNDED' };
      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce(refundedPayment);
      prisma.paymentEvent.create.mockResolvedValue({});

      const result = await service.cancelPayment('pay_test-uuid-1234', { reason: 'defective' });

      expect(mockProvider.refund).toHaveBeenCalledWith({
        providerTxId: 'mock_tx_999',
        amount: 15000,
        metadata: { itemTransactions: [] },
      });
      expect(result.payment.status).toBe('REFUNDED');
      expect(publisher.publish).toHaveBeenCalledWith(
        'payment.refunded',
        expect.objectContaining({ status: 'REFUNDED' }),
      );
    });

    it('stores cancelReason in the payment update', async () => {
      const authorizedPayment = { ...baseFakePayment, status: 'AUTHORIZED', providerTxId: 'mock_tx_999' };
      prisma.payment.findUnique.mockResolvedValueOnce(authorizedPayment);
      mockProvider.void.mockResolvedValue({ success: true });

      prisma.payment.updateMany.mockResolvedValue({ count: 1 });
      prisma.payment.findUnique.mockResolvedValueOnce({ ...authorizedPayment, status: 'VOIDED' });
      prisma.paymentEvent.create.mockResolvedValue({});

      await service.cancelPayment('pay_test-uuid-1234', { reason: 'changed mind' });

      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelReason: 'changed mind' }),
        }),
      );
    });

    it.each(['CREATED', 'AWAITING_FORM', 'FAILED', 'VOIDED', 'REFUNDED'])(
      'throws INVALID_STATE_TRANSITION (409) for status %s',
      async (status) => {
        const payment = { ...baseFakePayment, status };
        prisma.payment.findUnique.mockResolvedValueOnce(payment);

        await expect(
          service.cancelPayment('pay_test-uuid-1234', { reason: 'test' }),
        ).rejects.toMatchObject({
          code: 'INVALID_STATE_TRANSITION',
          statusCode: 409,
        });
      },
    );
  });

  // ─── getPayment ───────────────────────────────────────────────────────

  describe('getPayment()', () => {
    it('returns the payment when found', async () => {
      prisma.payment.findUnique.mockResolvedValue(baseFakePayment);

      const result = await service.getPayment('pay_test-uuid-1234');

      expect(result).toEqual(baseFakePayment);
    });

    it('throws PAYMENT_NOT_FOUND (404) when not found', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(service.getPayment('pay_nonexistent')).rejects.toMatchObject({
        code: 'PAYMENT_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  // ─── getPaymentsByOrder ───────────────────────────────────────────────

  describe('getPaymentsByOrder()', () => {
    it('calls prisma.payment.findMany with correct where/orderBy/include', async () => {
      const payments = [baseFakePayment];
      prisma.payment.findMany.mockResolvedValue(payments);

      const result = await service.getPaymentsByOrder('order-1');

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1' },
        orderBy: { createdAt: 'desc' },
        include: { events: true },
      });
      expect(result).toEqual(payments);
    });
  });

  // ─── getRecentPayments ────────────────────────────────────────────────

  describe('getRecentPayments()', () => {
    it('defaults to 50 if no limit passed', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await service.getRecentPayments();

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });

    it('uses provided limit', async () => {
      prisma.payment.findMany.mockResolvedValue([]);

      await service.getRecentPayments(10);

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    });
  });

  // ─── _transitionPayment ───────────────────────────────────────────────

  describe('_transitionPayment() (internal)', () => {
    it('throws CONCURRENT_MODIFICATION (409) when updateMany returns count: 0', async () => {
      prisma.payment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service._transitionPayment('pay_123', 'CREATED', 'AWAITING_FORM', {}),
      ).rejects.toMatchObject({
        code: 'CONCURRENT_MODIFICATION',
        statusCode: 409,
      });
    });

    it('calls assertTransition before updating', async () => {
      // Invalid transition should throw before hitting prisma
      await expect(
        service._transitionPayment('pay_123', 'FAILED', 'AUTHORIZED', {}),
      ).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });

      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── _eventPayload ────────────────────────────────────────────────────

  describe('_eventPayload()', () => {
    it('returns object with paymentId, orderId, userId, amount, currency, status, timestamp', () => {
      const payment = {
        id: 'pay_1',
        orderId: 'order-1',
        userId: 'user-1',
        amount: 15000,
        currency: 'TRY',
        status: 'AUTHORIZED',
      };

      const payload = service._eventPayload(payment);

      expect(payload).toEqual(
        expect.objectContaining({
          paymentId: 'pay_1',
          orderId: 'order-1',
          userId: 'user-1',
          amount: 15000,
          currency: 'TRY',
          status: 'AUTHORIZED',
        }),
      );
      expect(payload.timestamp).toBeDefined();
      expect(typeof payload.timestamp).toBe('string');
    });
  });
});
