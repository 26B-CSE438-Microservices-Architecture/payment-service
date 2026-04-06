const prisma = require('../lib/prisma');
const config = require('../config');
const { generatePaymentId } = require('../utils/id');
const { assertTransition } = require('./PaymentStateMachine');
const publisher = require('../queue/publisher');

class PaymentService {
  constructor(provider, cardService) {
    this.provider = provider;
    this.cardService = cardService;
  }

  async createPayment({ idempotencyKey, orderId, userId, amount, currency, paymentMethod, buyer, items, card, callbackUrl: inputCallbackUrl, savedCardId, saveCard }) {
    // 1. Idempotency check
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey },
      include: { events: true },
    });
    if (existing) {
      return { payment: existing, duplicate: true };
    }

    // 2. If orderId already has an AUTHORIZED payment, void it (retry with new card)
    const previousAuth = await prisma.payment.findFirst({
      where: { orderId, status: 'AUTHORIZED' },
    });
    if (previousAuth) {
      await this._voidPayment(previousAuth);
    }

    // 3. Validate card input
    if (savedCardId && card) {
      const error = new Error('Provide either card details or savedCardId, not both');
      error.code = 'MISSING_CARD_DETAILS';
      error.statusCode = 400;
      throw error;
    }
    if (!savedCardId && !card) {
      const error = new Error('Either card details or savedCardId is required');
      error.code = 'MISSING_CARD_DETAILS';
      error.statusCode = 400;
      throw error;
    }

    // 4. Resolve saved card if needed
    let resolvedCard = card;
    if (savedCardId) {
      resolvedCard = await this.cardService.getCardForPayment(userId, savedCardId);
    }

    // 5. Create payment record
    const paymentId = generatePaymentId();
    const metadata = {};
    if (buyer) metadata.buyer = buyer;
    if (items) metadata.items = items;
    if (saveCard) metadata.saveCard = true;

    const payment = await prisma.payment.create({
      data: {
        id: paymentId,
        idempotencyKey,
        orderId,
        userId,
        amount,
        currency: currency || 'TRY',
        method: paymentMethod || 'card',
        status: 'CREATED',
        provider: config.paymentProvider,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      },
    });

    // 6. Call provider.authorize
    let callbackUrl;
    if (config.payment3dsEnabled) {
      if (inputCallbackUrl) {
        callbackUrl = inputCallbackUrl.replace('{paymentId}', paymentId);
      } else {
        callbackUrl = `${config.apiBaseUrl || `http://localhost:${config.port}`}/payments/${paymentId}/3ds/callback`;
      }
    }

    let result;
    try {
      result = await this.provider.authorize({
        amount,
        currency: currency || 'TRY',
        card: resolvedCard,
        buyer,
        items,
        paymentId,
        callbackUrl,
        registerCard: (saveCard && !savedCardId) ? '1' : '0',
      });
    } catch (err) {
      // Provider error → mark as FAILED
      const updated = await this._transitionPayment(payment.id, 'CREATED', 'FAILED', {
        failureReason: err.message,
      });
      await this._logEvent(payment.id, 'CREATED', 'FAILED', 'system', { error: err.message });
      publisher.publish('payment.failed', this._eventPayload(updated));
      return { payment: updated };
    }

    // 5. Handle result
    if (result.type === '3ds_redirect') {
      const updated = await this._transitionPayment(payment.id, 'CREATED', 'AWAITING_3DS', {
        providerTxId: result.providerPaymentId || null,
      });
      await this._logEvent(payment.id, 'CREATED', 'AWAITING_3DS', 'system', {
        threeDSInitiated: true,
      });
      return {
        payment: updated,
        threeDSRedirect: {
          threeDSHtmlContent: result.threeDSHtmlContent,
        },
      };
    }

    if (result.success) {
      // Store itemTransactions in metadata for future refunds
      const updatedMetadata = {
        ...(payment.metadata || {}),
        itemTransactions: result.itemTransactions || [],
      };
      const updated = await this._transitionPayment(payment.id, 'CREATED', 'AUTHORIZED', {
        providerTxId: result.providerTxId,
        authorizedAt: new Date(),
        metadata: updatedMetadata,
      });
      await this._logEvent(payment.id, 'CREATED', 'AUTHORIZED', 'system', {
        providerTxId: result.providerTxId,
      });
      publisher.publish('payment.authorized', this._eventPayload(updated));

      // Save card if requested (fire-and-forget)
      if (saveCard && result.cardUserKey && result.cardToken) {
        try {
          await this.cardService.saveCardFromPayment({
            userId,
            cardUserKey: result.cardUserKey,
            cardToken: result.cardToken,
            last4: result.last4,
            cardAssociation: result.cardAssociation,
            cardType: result.cardType,
            cardBankName: result.cardBankName,
          });
        } catch (err) {
          console.warn('Failed to save card during payment:', err.message);
        }
      }

      return { payment: updated };
    }

    // Direct failure
    const updated = await this._transitionPayment(payment.id, 'CREATED', 'FAILED', {
      failureReason: result.failureReason,
    });
    await this._logEvent(payment.id, 'CREATED', 'FAILED', 'system', {
      reason: result.failureReason,
    });
    publisher.publish('payment.failed', this._eventPayload(updated));
    return { payment: updated };
  }

  async complete3DS(paymentId, { providerPaymentId, conversationData }) {
    const payment = await this._findPaymentOrThrow(paymentId);
    assertTransition(payment.status, 'AUTHORIZED'); // validates it's AWAITING_3DS

    const result = await this.provider.complete3DS({
      providerPaymentId: providerPaymentId || payment.providerTxId,
      conversationData,
    });

    if (result.success) {
      // Store itemTransactions in metadata for future refunds
      const updatedMetadata = {
        ...(payment.metadata || {}),
        itemTransactions: result.itemTransactions || [],
      };
      const updated = await this._transitionPayment(paymentId, 'AWAITING_3DS', 'AUTHORIZED', {
        providerTxId: result.providerTxId,
        authorizedAt: new Date(),
        metadata: updatedMetadata,
      });
      await this._logEvent(paymentId, 'AWAITING_3DS', 'AUTHORIZED', 'system', {
        providerTxId: result.providerTxId,
      });
      publisher.publish('payment.authorized', this._eventPayload(updated));

      // Save card if requested during original payment creation (fire-and-forget)
      if (payment.metadata?.saveCard && result.cardUserKey && result.cardToken) {
        try {
          await this.cardService.saveCardFromPayment({
            userId: payment.userId,
            cardUserKey: result.cardUserKey,
            cardToken: result.cardToken,
            last4: result.last4,
            cardAssociation: result.cardAssociation,
            cardType: result.cardType,
            cardBankName: result.cardBankName,
          });
        } catch (err) {
          console.warn('Failed to save card after 3DS:', err.message);
        }
      }

      return { payment: updated };
    }

    const updated = await this._transitionPayment(paymentId, 'AWAITING_3DS', 'FAILED', {
      failureReason: result.failureReason,
    });
    await this._logEvent(paymentId, 'AWAITING_3DS', 'FAILED', 'system', {
      reason: result.failureReason,
    });
    publisher.publish('payment.failed', this._eventPayload(updated));
    return { payment: updated };
  }

  async capturePayment(paymentId, { amount } = {}) {
    const payment = await this._findPaymentOrThrow(paymentId);
    assertTransition(payment.status, 'CAPTURED');

    if (amount !== undefined && amount !== payment.amount) {
      const error = new Error('Partial capture is not supported. Amount must match the authorized amount.');
      error.code = 'AMOUNT_MISMATCH';
      error.statusCode = 400;
      throw error;
    }

    await this.provider.capture({ providerTxId: payment.providerTxId, amount: payment.amount, currency: payment.currency });

    const updated = await this._transitionPayment(paymentId, 'AUTHORIZED', 'CAPTURED', {
      capturedAt: new Date(),
    });
    await this._logEvent(paymentId, 'AUTHORIZED', 'CAPTURED', 'system');
    publisher.publish('payment.captured', this._eventPayload(updated));
    return { payment: updated };
  }

  async cancelPayment(paymentId, { reason } = {}) {
    const payment = await this._findPaymentOrThrow(paymentId);

    if (payment.status === 'AUTHORIZED') {
      await this.provider.void({ providerTxId: payment.providerTxId });
      const updated = await this._transitionPayment(paymentId, 'AUTHORIZED', 'VOIDED', {
        cancelledAt: new Date(),
        cancelReason: reason || null,
      });
      await this._logEvent(paymentId, 'AUTHORIZED', 'VOIDED', 'system', { reason });
      publisher.publish('payment.voided', this._eventPayload(updated));
      return { payment: updated };
    }

    if (payment.status === 'CAPTURED') {
      await this.provider.refund({
        providerTxId: payment.providerTxId,
        amount: payment.amount,
        metadata: payment.metadata,
      });
      const updated = await this._transitionPayment(paymentId, 'CAPTURED', 'REFUNDED', {
        cancelledAt: new Date(),
        cancelReason: reason || null,
      });
      await this._logEvent(paymentId, 'CAPTURED', 'REFUNDED', 'system', { reason });
      publisher.publish('payment.refunded', this._eventPayload(updated));
      return { payment: updated };
    }

    const error = new Error(`Cannot cancel payment in status: ${payment.status}`);
    error.code = 'INVALID_STATE_TRANSITION';
    error.statusCode = 409;
    throw error;
  }

  async getPayment(paymentId) {
    return this._findPaymentOrThrow(paymentId);
  }

  async getPaymentsByOrder(orderId) {
    return prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      include: { events: true },
    });
  }

  async getRecentPayments(limit = 50) {
    return prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // --- Internal helpers ---

  async _voidPayment(payment) {
    try {
      await this.provider.void({ providerTxId: payment.providerTxId });
      await this._transitionPayment(payment.id, 'AUTHORIZED', 'VOIDED', {
        cancelledAt: new Date(),
        cancelReason: 'auto_voided_for_retry',
      });
      await this._logEvent(payment.id, 'AUTHORIZED', 'VOIDED', 'system', {
        reason: 'auto_voided_for_retry',
      });
      publisher.publish('payment.voided', this._eventPayload({ ...payment, status: 'VOIDED' }));
    } catch (err) {
      console.error('Failed to auto-void previous payment:', err.message);
    }
  }

  async _transitionPayment(paymentId, expectedStatus, newStatus, data = {}) {
    assertTransition(expectedStatus, newStatus);

    const result = await prisma.payment.updateMany({
      where: { id: paymentId, status: expectedStatus },
      data: { status: newStatus, ...data },
    });

    if (result.count === 0) {
      const error = new Error(`Concurrent modification: payment ${paymentId} is no longer in ${expectedStatus} status`);
      error.code = 'CONCURRENT_MODIFICATION';
      error.statusCode = 409;
      throw error;
    }

    return prisma.payment.findUnique({ where: { id: paymentId } });
  }

  async _logEvent(paymentId, fromStatus, toStatus, triggeredBy, details) {
    return prisma.paymentEvent.create({
      data: {
        paymentId,
        fromStatus,
        toStatus,
        triggeredBy,
        details: details || undefined,
      },
    });
  }

  async _findPaymentOrThrow(paymentId) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { events: true },
    });
    if (!payment) {
      const error = new Error(`No payment found with id ${paymentId}`);
      error.code = 'PAYMENT_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    return payment;
  }

  _eventPayload(payment) {
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = PaymentService;
