const express = require('express');
const authMiddleware = require('../middleware/auth');
const idempotencyMiddleware = require('../middleware/idempotency');

const router = express.Router();

// PaymentService instance is injected via setup function
let paymentService;

function setup(service) {
  paymentService = service;
}

// POST /payments — create + authorize (saved card) or init checkout form (new card)
router.post('/', authMiddleware, idempotencyMiddleware, async (req, res, next) => {
  try {
    const { orderId, amount, currency, paymentMethod, buyer, items, callbackUrl, savedCardId } = req.body;

    const result = await paymentService.createPayment({
      idempotencyKey: req.idempotencyKey,
      orderId,
      userId: req.userId,
      amount,
      currency,
      paymentMethod,
      buyer,
      items,
      callbackUrl,
      savedCardId,
    });

    const response = { payment: result.payment };
    if (result.checkoutForm) {
      response.checkoutForm = result.checkoutForm;
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

// POST /payments/:paymentId/checkout-form/callback — NO auth (forwarded by Order Service from iyzico's callback)
router.post('/:paymentId/checkout-form/callback', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      const error = new Error('token is required in the callback body');
      error.code = 'MISSING_FORM_TOKEN';
      error.statusCode = 400;
      throw error;
    }
    const result = await paymentService.completeCheckoutForm(req.params.paymentId, { token });
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
