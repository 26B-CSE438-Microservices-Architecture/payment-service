const express = require('express');
const authMiddleware = require('../middleware/auth');
const idempotencyMiddleware = require('../middleware/idempotency');

const router = express.Router();

// PaymentService instance is injected via setup function
let paymentService;

function setup(service) {
  paymentService = service;
}

// POST /payments — create + authorize
router.post('/', authMiddleware, idempotencyMiddleware, async (req, res, next) => {
  try {
    const { orderId, amount, currency, paymentMethod, buyer, items, card, callbackUrl, savedCardId, saveCard } = req.body;

    const result = await paymentService.createPayment({
      idempotencyKey: req.idempotencyKey,
      orderId,
      userId: req.userId,
      amount,
      currency,
      paymentMethod,
      buyer,
      items,
      card,
      callbackUrl,
      savedCardId,
      saveCard,
    });

    const response = { payment: result.payment };
    if (result.threeDSRedirect) {
      response.threeDSRedirect = result.threeDSRedirect;
    }

    res.status(result.duplicate ? 200 : 201).json(response);
  } catch (err) {
    next(err);
  }
});

// POST /payments/:paymentId/capture
router.post('/:paymentId/capture', authMiddleware, async (req, res, next) => {
  try {
    const { amount } = req.body;
    const result = await paymentService.capturePayment(req.params.paymentId, { amount });
    res.json({ payment: result.payment });
  } catch (err) {
    next(err);
  }
});

// POST /payments/:paymentId/cancel
router.post('/:paymentId/cancel', authMiddleware, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const result = await paymentService.cancelPayment(req.params.paymentId, { reason });
    res.json({ payment: result.payment });
  } catch (err) {
    next(err);
  }
});

// POST /payments/:paymentId/3ds/callback — NO auth (comes from provider/bank redirect)
router.post('/:paymentId/3ds/callback', async (req, res, next) => {
  try {
    const { paymentId: providerPaymentId, conversationData } = req.body;
    const result = await paymentService.complete3DS(req.params.paymentId, {
      providerPaymentId,
      conversationData,
    });
    res.json({ payment: result.payment });
  } catch (err) {
    next(err);
  }
});

// GET /payments/:paymentId
router.get('/:paymentId', authMiddleware, async (req, res, next) => {
  try {
    const payment = await paymentService.getPayment(req.params.paymentId);
    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

// GET /payments?orderId=X or GET /payments (all recent)
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const { orderId } = req.query;
    if (orderId) {
      const payments = await paymentService.getPaymentsByOrder(orderId);
      return res.json({ payments });
    }
    const payments = await paymentService.getRecentPayments();
    res.json({ payments });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, setup };
