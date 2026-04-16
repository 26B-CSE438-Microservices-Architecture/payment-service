// Mock iyzipay before requiring IyzicoProvider
const mockIyzipayInstance = {
  checkoutFormInitializePreAuth: { create: jest.fn() },
  checkoutForm: { retrieve: jest.fn() },
  paymentPostAuth: { create: jest.fn() },
  cancel: { create: jest.fn() },
  refund: { create: jest.fn() },
};

jest.mock('iyzipay', () => {
  const MockIyzipay = jest.fn(() => mockIyzipayInstance);
  MockIyzipay.LOCALE = { TR: 'tr' };
  MockIyzipay.CURRENCY = { TRY: 'TRY' };
  MockIyzipay.PAYMENT_GROUP = { PRODUCT: 'PRODUCT' };
  MockIyzipay.BASKET_ITEM_TYPE = { PHYSICAL: 'PHYSICAL' };
  return MockIyzipay;
});

jest.mock('../../src/config', () => ({
  iyzicoApiKey: 'test-api-key',
  iyzicoSecretKey: 'test-secret-key',
  iyzicoBaseUrl: 'https://sandbox-api.iyzipay.com',
}));

const IyzicoProvider = require('../../src/providers/IyzicoProvider');

describe('IyzicoProvider', () => {
  let provider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new IyzicoProvider();
    // Override the client with our mock
    provider.client = mockIyzipayInstance;
  });

  // ─── initCheckoutForm ─────────────────────────────────────────────────

  describe('initCheckoutForm()', () => {
    it('returns { token, content, paymentPageUrl } on iyzico status: "success"', async () => {
      mockIyzipayInstance.checkoutFormInitializePreAuth.create.mockImplementation((req, cb) => {
        cb(null, {
          status: 'success',
          token: 'iyzico_tok_123',
          checkoutFormContent: '<script>iyzico</script>',
          paymentPageUrl: 'https://sandbox.iyzipay.com/form',
        });
      });

      const result = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 15000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      expect(result.token).toBe('iyzico_tok_123');
      expect(result.content).toBe('<script>iyzico</script>');
      expect(result.paymentPageUrl).toBe('https://sandbox.iyzipay.com/form');
    });

    it('throws CHECKOUT_FORM_INIT_FAILED when iyzico returns failure', async () => {
      mockIyzipayInstance.checkoutFormInitializePreAuth.create.mockImplementation((req, cb) => {
        cb(null, {
          status: 'failure',
          errorMessage: 'Invalid API credentials',
        });
      });

      await expect(
        provider.initCheckoutForm({
          paymentId: 'pay_1',
          amount: 15000,
          currency: 'TRY',
          callbackUrl: 'https://example.com/callback',
        }),
      ).rejects.toMatchObject({
        code: 'CHECKOUT_FORM_INIT_FAILED',
        message: 'Invalid API credentials',
      });
    });
  });

  // ─── retrieveCheckoutForm ─────────────────────────────────────────────

  describe('retrieveCheckoutForm()', () => {
    it('returns { success: true, providerTxId, itemTransactions } on success', async () => {
      mockIyzipayInstance.checkoutForm.retrieve.mockImplementation((req, cb) => {
        cb(null, {
          status: 'success',
          paymentStatus: 'SUCCESS',
          paymentId: '12345',
          itemTransactions: [
            { itemId: 'ITEM_1', paymentTransactionId: 'txn_1', price: '150.00' },
          ],
        });
      });

      const result = await provider.retrieveCheckoutForm('iyzico_tok_123');

      expect(result.success).toBe(true);
      expect(result.providerTxId).toBe('12345');
      expect(result.itemTransactions).toEqual([
        { itemId: 'ITEM_1', paymentTransactionId: 'txn_1', price: '150.00' },
      ]);
    });

    it('returns { success: false, failureReason } on failure', async () => {
      mockIyzipayInstance.checkoutForm.retrieve.mockImplementation((req, cb) => {
        cb(null, {
          status: 'failure',
          paymentStatus: 'FAILURE',
          errorMessage: 'Card declined',
        });
      });

      const result = await provider.retrieveCheckoutForm('iyzico_tok_123');

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe('Card declined');
    });
  });

  // ─── capture ──────────────────────────────────────────────────────────

  describe('capture()', () => {
    it('succeeds on status: "success"', async () => {
      mockIyzipayInstance.paymentPostAuth.create.mockImplementation((req, cb) => {
        cb(null, { status: 'success' });
      });

      const result = await provider.capture({
        providerTxId: 'iyz_12345',
        amount: 15000,
        currency: 'TRY',
      });

      expect(result.success).toBe(true);
    });

    it('throws on failure', async () => {
      mockIyzipayInstance.paymentPostAuth.create.mockImplementation((req, cb) => {
        cb(null, { status: 'failure', errorMessage: 'Capture failed' });
      });

      await expect(
        provider.capture({ providerTxId: 'iyz_12345', amount: 15000, currency: 'TRY' }),
      ).rejects.toThrow('Capture failed');
    });
  });

  // ─── void ─────────────────────────────────────────────────────────────

  describe('void()', () => {
    it('succeeds on status: "success"', async () => {
      mockIyzipayInstance.cancel.create.mockImplementation((req, cb) => {
        cb(null, { status: 'success' });
      });

      const result = await provider.void({ providerTxId: 'iyz_12345' });

      expect(result.success).toBe(true);
    });

    it('throws on failure', async () => {
      mockIyzipayInstance.cancel.create.mockImplementation((req, cb) => {
        cb(null, { status: 'failure', errorMessage: 'Void failed' });
      });

      await expect(
        provider.void({ providerTxId: 'iyz_12345' }),
      ).rejects.toThrow('Void failed');
    });
  });

  // ─── refund ───────────────────────────────────────────────────────────

  describe('refund()', () => {
    it('succeeds when cancel works (same-day refund)', async () => {
      mockIyzipayInstance.cancel.create.mockImplementation((req, cb) => {
        cb(null, { status: 'success' });
      });

      const result = await provider.refund({
        providerTxId: 'iyz_12345',
        amount: 15000,
        metadata: {},
      });

      expect(result.success).toBe(true);
    });

    it('falls back to per-item refund when cancel fails', async () => {
      // Cancel fails
      mockIyzipayInstance.cancel.create.mockImplementation((req, cb) => {
        cb(new Error('Cancel failed'));
      });

      // Per-item refund succeeds
      mockIyzipayInstance.refund.create.mockImplementation((req, cb) => {
        cb(null, { status: 'success' });
      });

      const result = await provider.refund({
        providerTxId: 'iyz_12345',
        amount: 15000,
        metadata: {
          itemTransactions: [
            { paymentTransactionId: 'txn_1', price: '150.00' },
          ],
        },
      });

      expect(result.success).toBe(true);
      expect(mockIyzipayInstance.refund.create).toHaveBeenCalled();
    });

    it('throws if no itemTransactions in metadata when falling back to per-item refund', async () => {
      mockIyzipayInstance.cancel.create.mockImplementation((req, cb) => {
        cb(new Error('Cancel failed'));
      });

      await expect(
        provider.refund({
          providerTxId: 'iyz_12345',
          amount: 15000,
          metadata: {},
        }),
      ).rejects.toThrow('Cannot refund: no itemTransactions stored in metadata');
    });

    it('throws if per-item refund returns failure', async () => {
      mockIyzipayInstance.cancel.create.mockImplementation((req, cb) => {
        cb(new Error('Cancel failed'));
      });

      mockIyzipayInstance.refund.create.mockImplementation((req, cb) => {
        cb(null, { status: 'failure', errorMessage: 'Refund error' });
      });

      await expect(
        provider.refund({
          providerTxId: 'iyz_12345',
          amount: 15000,
          metadata: {
            itemTransactions: [
              { paymentTransactionId: 'txn_1', price: '150.00' },
            ],
          },
        }),
      ).rejects.toThrow('Refund failed for item');
    });
  });

  // ─── _mapBuyer ────────────────────────────────────────────────────────

  describe('_mapBuyer()', () => {
    it('fills defaults for missing buyer fields', () => {
      const mapped = provider._mapBuyer({});

      expect(mapped.id).toBe('BUYER_DEFAULT');
      expect(mapped.name).toBe('N/A');
      expect(mapped.surname).toBe('N/A');
      expect(mapped.gsmNumber).toBe('+905000000000');
      expect(mapped.email).toBe('noreply@example.com');
      expect(mapped.identityNumber).toBe('00000000000');
      expect(mapped.ip).toBe('127.0.0.1');
      expect(mapped.city).toBe('Istanbul');
      expect(mapped.country).toBe('Turkey');
      expect(mapped.zipCode).toBe('00000');
    });

    it('uses provided buyer fields when given', () => {
      const buyer = {
        id: 'B100',
        name: 'John',
        surname: 'Doe',
        email: 'john@example.com',
        gsmNumber: '+905551234567',
        identityNumber: '12345678901',
        ip: '192.168.1.1',
        city: 'Ankara',
        country: 'Turkey',
        zipCode: '06000',
      };

      const mapped = provider._mapBuyer(buyer);

      expect(mapped.id).toBe('B100');
      expect(mapped.name).toBe('John');
      expect(mapped.email).toBe('john@example.com');
    });

    it('handles undefined buyer (defaults all fields)', () => {
      const mapped = provider._mapBuyer(undefined);
      expect(mapped.id).toBe('BUYER_DEFAULT');
      expect(mapped.email).toBe('noreply@example.com');
    });
  });

  // ─── _mapAddress ──────────────────────────────────────────────────────

  describe('_mapAddress()', () => {
    it('fills defaults for missing address fields', () => {
      const mapped = provider._mapAddress({});

      expect(mapped.contactName).toBe('N/A');
      expect(mapped.city).toBe('Istanbul');
      expect(mapped.country).toBe('Turkey');
      expect(mapped.address).toBe('N/A');
      expect(mapped.zipCode).toBe('00000');
    });

    it('builds contactName from name+surname when contactName is missing', () => {
      const mapped = provider._mapAddress({ name: 'Jane', surname: 'Doe' });
      expect(mapped.contactName).toBe('Jane Doe');
    });

    it('handles undefined address', () => {
      const mapped = provider._mapAddress(undefined);
      expect(mapped.city).toBe('Istanbul');
    });
  });

  // ─── _mapBasketItems ──────────────────────────────────────────────────

  describe('_mapBasketItems()', () => {
    it('maps provided items', () => {
      const items = [
        { id: 'ITEM_1', name: 'Shirt', category1: 'Clothing', price: '50.00' },
      ];

      const mapped = provider._mapBasketItems(items, 5000);

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('ITEM_1');
      expect(mapped[0].name).toBe('Shirt');
      expect(mapped[0].category1).toBe('Clothing');
    });

    it('creates single default item when no items provided', () => {
      const mapped = provider._mapBasketItems(null, 15000);

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('ITEM_DEFAULT');
      expect(mapped[0].name).toBe('Order Payment');
      expect(mapped[0].price).toBe('150.00');
    });

    it('creates single default item for empty array', () => {
      const mapped = provider._mapBasketItems([], 10000);

      expect(mapped).toHaveLength(1);
      expect(mapped[0].id).toBe('ITEM_DEFAULT');
    });
  });

  // ─── _formatPrice ─────────────────────────────────────────────────────

  describe('_formatPrice()', () => {
    it('converts minor units (cents/kuruş) to string with 2 decimals', () => {
      expect(provider._formatPrice(15000)).toBe('150.00');
      expect(provider._formatPrice(100)).toBe('1.00');
      expect(provider._formatPrice(1)).toBe('0.01');
      expect(provider._formatPrice(0)).toBe('0.00');
      expect(provider._formatPrice(9999)).toBe('99.99');
    });
  });

  // ─── _extractItemTransactions ─────────────────────────────────────────

  describe('_extractItemTransactions()', () => {
    it('maps iyzico response format to internal format', () => {
      const result = {
        itemTransactions: [
          { itemId: 'ITEM_1', paymentTransactionId: 12345, price: 150.0 },
          { itemId: 'ITEM_2', paymentTransactionId: 67890, paidPrice: 50.0 },
        ],
      };

      const mapped = provider._extractItemTransactions(result);

      expect(mapped).toEqual([
        { itemId: 'ITEM_1', paymentTransactionId: '12345', price: '150' },
        { itemId: 'ITEM_2', paymentTransactionId: '67890', price: '50' },
      ]);
    });

    it('returns empty array when no itemTransactions in result', () => {
      const mapped = provider._extractItemTransactions({});
      expect(mapped).toEqual([]);
    });
  });
});
