const Iyzipay = require('iyzipay');
const config = require('../config');

class IyzicoProvider {
  constructor() {
    this.client = new Iyzipay({
      apiKey: config.iyzicoApiKey,
      secretKey: config.iyzicoSecretKey,
      uri: config.iyzicoBaseUrl,
    });
  }

  async authorize({ amount, currency, card, buyer, items, paymentId, callbackUrl, registerCard }) {
    const request = this._buildRequest({ amount, currency, card, buyer, items, paymentId, registerCard });

    if (config.payment3dsEnabled) {
      if (!callbackUrl) {
        throw new Error('callbackUrl is required when 3DS is enabled');
      }
      request.callbackUrl = callbackUrl;
      return this._initiate3DS(request);
    }

    return this._directPreAuth(request);
  }

  async complete3DS({ providerPaymentId, conversationData }) {
    const result = await this._call('threedsPayment', 'create', {
      locale: Iyzipay.LOCALE.TR,
      paymentId: providerPaymentId,
      conversationData,
    });

    if (result.status === 'success') {
      const response = {
        success: true,
        providerTxId: String(result.paymentId),
        itemTransactions: this._extractItemTransactions(result),
      };
      if (result.cardUserKey) response.cardUserKey = result.cardUserKey;
      if (result.cardToken) response.cardToken = result.cardToken;
      if (result.binNumber) response.last4 = result.lastFourDigits || result.binNumber.slice(-4);
      if (result.cardAssociation) response.cardAssociation = result.cardAssociation;
      if (result.cardType) response.cardType = result.cardType;
      if (result.cardFamily) response.cardBankName = result.cardFamily;
      return response;
    }

    return {
      success: false,
      failureReason: result.errorMessage || '3ds_authentication_failed',
    };
  }

  async capture({ providerTxId, amount, currency }) {
    const result = await this._call('paymentPostAuth', 'create', {
      locale: Iyzipay.LOCALE.TR,
      paymentId: providerTxId,
      paidPrice: this._formatPrice(amount),
      currency: currency || Iyzipay.CURRENCY.TRY,
      ip: '127.0.0.1',
    });

    if (result.status !== 'success') {
      throw new Error(result.errorMessage || 'Capture failed at iyzico');
    }

    return { success: true };
  }

  async void({ providerTxId }) {
    const result = await this._call('cancel', 'create', {
      locale: Iyzipay.LOCALE.TR,
      paymentId: providerTxId,
      ip: '127.0.0.1',
    });

    if (result.status !== 'success') {
      throw new Error(result.errorMessage || 'Void failed at iyzico');
    }

    return { success: true };
  }

  async refund({ providerTxId, amount, metadata }) {
    // Try cancel first (works same-day before settlement)
    try {
      const cancelResult = await this._call('cancel', 'create', {
        locale: Iyzipay.LOCALE.TR,
        paymentId: providerTxId,
        ip: '127.0.0.1',
      });
      if (cancelResult.status === 'success') {
        return { success: true };
      }
    } catch (err) {
      console.warn('iyzico cancel failed, falling back to per-item refund:', err.message);
    }

    // Fall back to per-item refund
    const itemTransactions = metadata?.itemTransactions;
    if (!itemTransactions || itemTransactions.length === 0) {
      throw new Error('Cannot refund: no itemTransactions stored in metadata');
    }

    for (const item of itemTransactions) {
      const result = await this._call('refund', 'create', {
        locale: Iyzipay.LOCALE.TR,
        paymentTransactionId: String(item.paymentTransactionId),
        price: String(item.price),
        currency: Iyzipay.CURRENCY.TRY,
        ip: '127.0.0.1',
      });

      if (result.status !== 'success') {
        throw new Error(
          `Refund failed for item ${item.paymentTransactionId}: ${result.errorMessage || 'unknown error'}`
        );
      }
    }

    return { success: true };
  }

  async registerCard({ card, email, cardUserKey, cardAlias }) {
    const request = {
      locale: Iyzipay.LOCALE.TR,
      email: email || 'noreply@example.com',
      cardAlias: cardAlias || 'Card',
      cardHolderName: card.cardHolderName,
      cardNumber: card.cardNumber,
      expireMonth: card.expireMonth,
      expireYear: card.expireYear,
    };
    if (cardUserKey) request.cardUserKey = cardUserKey;

    const result = await this._call('card', 'create', request);

    if (result.status !== 'success') {
      throw new Error(result.errorMessage || 'Card registration failed');
    }

    return {
      cardUserKey: result.cardUserKey,
      cardToken: result.cardToken,
      last4: result.lastFourDigits || (card.cardNumber || '').slice(-4),
      cardAssociation: result.cardAssociation || null,
      cardType: result.cardType || null,
      cardBankName: result.cardBankName || null,
    };
  }

  async deleteCard({ cardUserKey, cardToken }) {
    const result = await this._call('card', 'delete', {
      locale: Iyzipay.LOCALE.TR,
      cardUserKey,
      cardToken,
    });

    if (result.status !== 'success') {
      throw new Error(result.errorMessage || 'Card deletion failed');
    }

    return { success: true };
  }

  // --- Internal helpers ---

  async _directPreAuth(request) {
    const result = await this._call('paymentPreAuth', 'create', request);

    if (result.status === 'success') {
      const response = {
        type: 'direct',
        success: true,
        providerTxId: String(result.paymentId),
        itemTransactions: this._extractItemTransactions(result),
      };
      if (result.cardUserKey) response.cardUserKey = result.cardUserKey;
      if (result.cardToken) response.cardToken = result.cardToken;
      if (result.binNumber) response.last4 = result.lastFourDigits || result.binNumber.slice(-4);
      if (result.cardAssociation) response.cardAssociation = result.cardAssociation;
      if (result.cardType) response.cardType = result.cardType;
      if (result.cardFamily) response.cardBankName = result.cardFamily;
      return response;
    }

    return {
      type: 'direct',
      success: false,
      failureReason: result.errorMessage || 'payment_declined',
    };
  }

  async _initiate3DS(request) {
    const result = await this._call('threedsInitializePreAuth', 'create', request);

    if (result.status === 'success') {
      return {
        type: '3ds_redirect',
        threeDSHtmlContent: result.threeDSHtmlContent,
        providerPaymentId: result.paymentId ? String(result.paymentId) : undefined,
      };
    }

    return {
      type: 'direct',
      success: false,
      failureReason: result.errorMessage || '3ds_initialization_failed',
    };
  }

  _buildRequest({ amount, currency, card, buyer, items, paymentId, registerCard }) {
    this._warnMissingFields(buyer, items);

    const priceStr = this._formatPrice(amount);

    // Saved card: use cardUserKey + cardToken instead of raw card details
    const paymentCard = card.cardToken
      ? { cardUserKey: card.cardUserKey, cardToken: card.cardToken }
      : {
          cardHolderName: card.cardHolderName || 'Unknown',
          cardNumber: card.cardNumber,
          expireMonth: card.expireMonth,
          expireYear: card.expireYear,
          cvc: card.cvc,
          registerCard: registerCard || '0',
        };

    return {
      locale: Iyzipay.LOCALE.TR,
      conversationId: paymentId || undefined,
      price: priceStr,
      paidPrice: priceStr,
      currency: currency || Iyzipay.CURRENCY.TRY,
      installment: '1',
      basketId: paymentId || 'B1',
      paymentChannel: Iyzipay.PAYMENT_CHANNEL.WEB,
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      paymentCard,
      buyer: this._mapBuyer(buyer),
      shippingAddress: this._mapAddress(buyer?.shippingAddress || buyer),
      billingAddress: this._mapAddress(buyer?.billingAddress || buyer),
      basketItems: this._mapBasketItems(items, amount),
    };
  }

  _mapBuyer(buyer = {}) {
    return {
      id: buyer.id || 'BUYER_DEFAULT',
      name: buyer.name || 'N/A',
      surname: buyer.surname || 'N/A',
      gsmNumber: buyer.gsmNumber || '+905000000000',
      email: buyer.email || 'noreply@example.com',
      identityNumber: buyer.identityNumber || '00000000000',
      lastLoginDate: buyer.lastLoginDate || new Date().toISOString().replace('T', ' ').substring(0, 19),
      registrationDate: buyer.registrationDate || '2020-01-01 00:00:00',
      registrationAddress: buyer.registrationAddress || buyer.address || 'N/A',
      ip: buyer.ip || '127.0.0.1',
      city: buyer.city || 'Istanbul',
      country: buyer.country || 'Turkey',
      zipCode: buyer.zipCode || '00000',
    };
  }

  _mapAddress(addr = {}) {
    return {
      contactName: addr.contactName || [addr.name, addr.surname].filter(Boolean).join(' ') || 'N/A',
      city: addr.city || 'Istanbul',
      country: addr.country || 'Turkey',
      address: addr.address || 'N/A',
      zipCode: addr.zipCode || '00000',
    };
  }

  _mapBasketItems(items, totalAmount) {
    if (items && items.length > 0) {
      return items.map((item, i) => ({
        id: item.id || `ITEM_${i}`,
        name: item.name || `Item ${i + 1}`,
        category1: item.category1 || item.category || 'General',
        category2: item.category2 || undefined,
        itemType: item.itemType || Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
        price: item.price ? String(item.price) : this._formatPrice(item.amount || 0),
      }));
    }

    // Fallback: single basket item with the full amount
    return [{
      id: 'ITEM_DEFAULT',
      name: 'Order Payment',
      category1: 'General',
      itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
      price: this._formatPrice(totalAmount),
    }];
  }

  _extractItemTransactions(result) {
    if (!result.itemTransactions) return [];
    return result.itemTransactions.map((t) => ({
      itemId: t.itemId,
      paymentTransactionId: String(t.paymentTransactionId),
      price: String(t.price || t.paidPrice),
    }));
  }

  _formatPrice(amountInMinorUnits) {
    // Our system stores amount in minor units (kuruş), iyzico wants major units (TL) as string
    return (amountInMinorUnits / 100).toFixed(2);
  }

  _warnMissingFields(buyer, items) {
    const warnings = [];
    if (!buyer) warnings.push('buyer object is missing');
    else {
      if (!buyer.identityNumber) warnings.push('buyer.identityNumber');
      if (!buyer.email) warnings.push('buyer.email');
      if (!buyer.gsmNumber) warnings.push('buyer.gsmNumber');
      if (!buyer.name) warnings.push('buyer.name');
      if (!buyer.surname) warnings.push('buyer.surname');
      if (!buyer.ip) warnings.push('buyer.ip');
    }
    if (!items || items.length === 0) warnings.push('basket items are missing (using single-item fallback)');

    if (warnings.length > 0) {
      console.warn('[IyzicoProvider] Missing fields (using defaults):', warnings.join(', '));
    }
  }

  _call(resource, method, request) {
    return new Promise((resolve, reject) => {
      this.client[resource][method](request, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }
}

module.exports = IyzicoProvider;
