const express = require('express');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
let cardService;

function setup(service) {
  cardService = service;
}

// POST /cards — save a card (standalone, no payment)
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { card, email, cardAlias } = req.body;

    if (!card || !card.cardNumber) {
      const error = new Error('Card details (cardNumber, expireMonth, expireYear, cardHolderName) are required');
      error.code = 'MISSING_CARD_DETAILS';
      error.statusCode = 400;
      throw error;
    }

    const savedCard = await cardService.saveCard({
      userId: req.userId,
      card,
      email,
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
