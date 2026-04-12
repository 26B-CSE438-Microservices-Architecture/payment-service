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

  // Saved-card payments only (NON3D direct pre-auth)
  async authorize({ amount, currency, card, buyer, items, paymentId }) {
    if (!card.cardToken || !card.cardUserKey) {
      throw new Error('authorize() only accepts saved cards ({cardUserKey, cardToken}). New cards must use the Checkout Form flow.');
    }

    const request = this._buildRequest({ amount, currency, card, buyer, items, paymentId });
    return this._directPreAuth(request);
  }

  // Checkout Form — new card payment initialization (pre-auth)
  async initCheckoutForm({ paymentId, amount, currency, buyer, items, callbackUrl }) {
    this._warnMissingFields(buyer, items);

    const priceStr = this._formatPrice(amount);

    const request = {
      locale: Iyzipay.LOCALE.TR,
      conversationId: paymentId || undefined,
      price: priceStr,
      paidPrice: priceStr,
      currency: currency || Iyzipay.CURRENCY.TRY,
      basketId: paymentId || 'B1',
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      callbackUrl,
      buyer: this._mapBuyer(buyer),
      shippingAddress: this._mapAddress(buyer?.shippingAddress || buyer),
      billingAddress: this._mapAddress(buyer?.billingAddress || buyer),
      basketItems: this._mapBasketItems(items, amount),
    };

    const result = await this._call('checkoutFormInitializePreAuth', 'create', request);

    if (result.status === 'success') {
      return {
        token: result.token,
        content: result.checkoutFormContent,
        paymentPageUrl: result.paymentPageUrl || null,
      };
    }

    const error = new Error(result.errorMessage || 'Checkout form initialization failed');
    error.code = 'CHECKOUT_FORM_INIT_FAILED';
    throw error;
  }

  // Checkout Form — retrieve result after user completes the form
  async retrieveCheckoutForm(token) {
    const result = await this._call('checkoutForm', 'retrieve', {
      locale: Iyzipay.LOCALE.TR,
      token,
    });

    if (result.status === 'success' && result.paymentStatus === 'SUCCESS') {
      const response = {
        success: true,
        providerTxId: String(result.paymentId),
        itemTransactions: this._extractItemTransactions(result),
      };
      if (result.cardUserKey) response.cardUserKey = result.cardUserKey;
      if (result.cardToken) response.cardToken = result.cardToken;
      if (result.lastFourDigits) response.last4 = result.lastFourDigits;
      else if (result.binNumber) response.last4 = result.binNumber.slice(-4);
      if (result.cardAssociation) response.cardAssociation = result.cardAssociation;
      if (result.cardType) response.cardType = result.cardType;
      if (result.cardFamily) response.cardBankName = result.cardFamily;
      return response;
    }

    return {
      success: false,
      failureReason: result.errorMessage || result.paymentStatus || 'checkout_form_failed',
    };
  }

  // Universal Card Storage — initialize form for standalone card save
  async initUniversalCardStorage({ email, cardUserKey, cardAlias, callbackUrl }) {
    const request = {
      locale: Iyzipay.LOCALE.TR,
      email: email || 'noreply@example.com',
      callbackUrl,
    };
    if (cardUserKey) request.cardUserKey = cardUserKey;
    if (cardAlias) request.cardAlias = cardAlias;

    // The SDK resource method may be 'create' or 'retrieve' depending on version
    let result;
    try {
      result = await this._call('universalCardStorageInitialize', 'create', request);
    } catch (err) {
      // Fallback: some SDK versions expose this as 'retrieve' instead of 'create'
      result = await this._call('universalCardStorageInitialize', 'retrieve', request);
    }

    if (result.status === 'success') {
      return {
        token: result.token,
        content: result.ucsFormContent || result.checkoutFormContent || null,
      };
    }

    const error = new Error(result.errorMessage || 'Card storage initialization failed');
    error.code = 'CARD_STORAGE_INIT_FAILED';
    throw error;
  }

  // Universal Card Storage — retrieve card data after form completion
  // Since there's no dedicated retrieve resource, we use cardList to find the newly saved card
  async retrieveCardStorageForm(token, { cardUserKey } = {}) {
    if (!cardUserKey) {
      throw new Error('cardUserKey is required to retrieve card storage result');
    }

    const result = await this._call('cardList', 'retrieve', {
      locale: Iyzipay.LOCALE.TR,
      cardUserKey,
    });

    if (result.status !== 'success' || !result.cardDetails || result.cardDetails.length === 0) {
      const error = new Error(result.errorMessage || 'No cards found after storage');
      error.code = 'CARD_STORAGE_RETRIEVE_FAILED';
      throw error;
    }

    // Find the most recently added card (last in the list)
    const latestCard = result.cardDetails[result.cardDetails.length - 1];

    return {
      cardUserKey: result.cardUserKey || cardUserKey,
      cardToken: latestCard.cardToken,
      last4: latestCard.lastFourDigits || latestCard.binNumber?.slice(-4) || '****',
      cardAssociation: latestCard.cardAssociation || null,
      cardType: latestCard.cardType || null,
      cardBankName: latestCard.cardBankName || null,
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
      return {
        success: true,
        providerTxId: String(result.paymentId),
        itemTransactions: this._extractItemTransactions(result),
      };
    }

    return {
      success: false,
      failureReason: result.errorMessage || 'payment_declined',
    };
  }

  _buildRequest({ amount, currency, card, buyer, items, paymentId }) {
    this._warnMissingFields(buyer, items);

    const priceStr = this._formatPrice(amount);

    // Only saved-card path: cardUserKey + cardToken
    const paymentCard = { cardUserKey: card.cardUserKey, cardToken: card.cardToken };

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
