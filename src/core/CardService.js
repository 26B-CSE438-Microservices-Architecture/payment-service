const prisma = require('../lib/prisma');
const { generateCardId } = require('../utils/id');

class CardService {
  constructor(provider) {
    this.provider = provider;
  }

  // Phase 1: Initialize card storage form (PCI-safe — no raw card data)
  async initCardStorage({ userId, email, cardAlias, callbackUrl }) {
    // Look up existing cardUserKey for this user (reuse to avoid orphaning previous cards)
    const existing = await prisma.savedCard.findFirst({
      where: { userId },
      select: { cardUserKey: true },
    });

    const result = await this.provider.initUniversalCardStorage({
      email,
      cardUserKey: existing?.cardUserKey || undefined,
      cardAlias,
      callbackUrl,
    });

    return result; // { token, content }
  }

  // Phase 2: Complete card storage after user fills the form
  async completeCardStorage({ userId, token, cardAlias }) {
    // Look up existing cardUserKey for retrieve
    const existing = await prisma.savedCard.findFirst({
      where: { userId },
      select: { cardUserKey: true },
    });

    const result = await this.provider.retrieveCardStorageForm(token, {
      cardUserKey: existing?.cardUserKey,
    });

    // Check if this card is already saved (idempotent)
    const existingCard = await prisma.savedCard.findFirst({
      where: { userId, cardToken: result.cardToken },
    });
    if (existingCard) return existingCard;

    const savedCard = await prisma.savedCard.create({
      data: {
        id: generateCardId(),
        userId,
        cardUserKey: result.cardUserKey,
        cardToken: result.cardToken,
        last4: result.last4 || '****',
        cardType: result.cardType || null,
        cardAssociation: result.cardAssociation || null,
        cardBankName: result.cardBankName || null,
        cardAlias: cardAlias || null,
      },
    });

    return savedCard;
  }

  async saveCardFromPayment({ userId, cardUserKey, cardToken, last4, cardAssociation, cardType, cardBankName }) {
    if (!cardUserKey || !cardToken) return null;

    // Check if already saved (idempotent)
    const existing = await prisma.savedCard.findFirst({
      where: { userId, cardToken },
    });
    if (existing) return existing;

    return prisma.savedCard.create({
      data: {
        id: generateCardId(),
        userId,
        cardUserKey,
        cardToken,
        last4: last4 || '****',
        cardType: cardType || null,
        cardAssociation: cardAssociation || null,
        cardBankName: cardBankName || null,
      },
    });
  }

  async listCards(userId) {
    return prisma.savedCard.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteCard({ userId, cardId }) {
    const card = await prisma.savedCard.findUnique({ where: { id: cardId } });

    if (!card) {
      const error = new Error(`No saved card found with id ${cardId}`);
      error.code = 'CARD_NOT_FOUND';
      throw error;
    }

    if (card.userId !== userId) {
      const error = new Error('This card does not belong to you');
      error.code = 'CARD_NOT_OWNED';
      throw error;
    }

    // Delete from provider (best-effort)
    try {
      await this.provider.deleteCard({
        cardUserKey: card.cardUserKey,
        cardToken: card.cardToken,
      });
    } catch (err) {
      console.warn('Provider card deletion failed (removing from DB anyway):', err.message);
    }

    await prisma.savedCard.delete({ where: { id: cardId } });
  }

  async getCardForPayment(userId, savedCardId) {
    const card = await prisma.savedCard.findUnique({ where: { id: savedCardId } });

    if (!card) {
      const error = new Error(`No saved card found with id ${savedCardId}`);
      error.code = 'CARD_NOT_FOUND';
      throw error;
    }

    if (card.userId !== userId) {
      const error = new Error('This card does not belong to you');
      error.code = 'CARD_NOT_OWNED';
      throw error;
    }

    return { cardUserKey: card.cardUserKey, cardToken: card.cardToken };
  }
}

module.exports = CardService;
