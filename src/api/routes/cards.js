const express = require('express');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
let cardService;

function setup(service) {
  cardService = service;
}

// POST /cards — initialize card storage form (PCI-safe, no raw card data)
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { email, cardAlias, callbackUrl } = req.body;

    const result = await cardService.initCardStorage({
      userId: req.userId,
      email,
      cardAlias,
      callbackUrl,
    });

    res.status(201).json({ cardForm: result });
  } catch (err) {
    next(err);
  }
});

// POST /cards/checkout-form/callback — complete card storage after form submission (requires auth)
router.post('/checkout-form/callback', authMiddleware, async (req, res, next) => {
  try {
    const { token, cardAlias } = req.body;

    if (!token) {
      const error = new Error('token is required in the callback body');
      error.code = 'MISSING_FORM_TOKEN';
      error.statusCode = 400;
      throw error;
    }

    const savedCard = await cardService.completeCardStorage({
      userId: req.userId,
      token,
      cardAlias,
    });

    res.status(201).json({ card: savedCard });
  } catch (err) {
    next(err);
  }
});

// GET /cards — list user's saved cards
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const cards = await cardService.listCards(req.userId);
    res.json({ cards });
  } catch (err) {
    next(err);
  }
});

// DELETE /cards/:cardId — delete a saved card
router.delete('/:cardId', authMiddleware, async (req, res, next) => {
  try {
    await cardService.deleteCard({
      userId: req.userId,
      cardId: req.params.cardId,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = { router, setup };
