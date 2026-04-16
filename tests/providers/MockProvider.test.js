const MockProvider = require('../../src/providers/MockProvider');

describe('MockProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  // ─── initCheckoutForm ─────────────────────────────────────────────────

  describe('initCheckoutForm()', () => {
    it('returns { token, content, paymentPageUrl } with a base64-encoded HTML string', async () => {
      const result = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 15000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('paymentPageUrl');
      expect(typeof result.content).toBe('string');
      // Should be valid base64
      const decoded = Buffer.from(result.content, 'base64').toString('utf-8');
      expect(decoded).toContain('<!DOCTYPE html>');
    });

    it('token format matches mock_cf_*', async () => {
      const result = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      expect(result.token).toMatch(/^mock_cf_/);
    });
  });

  // ─── retrieveCheckoutForm ─────────────────────────────────────────────

  describe('retrieveCheckoutForm()', () => {
    it('returns success with providerTxId (format mock_tx_*) for a valid session', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      const result = await provider.retrieveCheckoutForm(form.token);

      expect(result.success).toBe(true);
      expect(result.providerTxId).toMatch(/^mock_tx_/);
      expect(result.itemTransactions).toBeDefined();
    });

    it('returns { success: false, failureReason: "form_not_found" } for unknown token', async () => {
      const result = await provider.retrieveCheckoutForm('unknown_token');

      expect(result.success).toBe(false);
      expect(result.failureReason).toBe('form_not_found');
    });

    it('sessions are cleaned up after retrieveCheckoutForm()', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      await provider.retrieveCheckoutForm(form.token);

      // Second call should not find the session
      const secondResult = await provider.retrieveCheckoutForm(form.token);
      expect(secondResult.success).toBe(false);
      expect(secondResult.failureReason).toBe('form_not_found');
    });
  });

  // ─── tagFormSession ───────────────────────────────────────────────────

  describe('tagFormSession()', () => {
    it('sets outcome/cardNumber on existing session', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      provider.tagFormSession(form.token, { outcome: 'fail', cardNumber: '4111111111111129' });

      const result = await provider.retrieveCheckoutForm(form.token);
      expect(result.success).toBe(false);
      expect(result.failureReason).toBe('card_declined');
    });

    it('returns failure reason "card_declined" for card 4111111111111129', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      provider.tagFormSession(form.token, { outcome: 'fail', cardNumber: '4111111111111129' });
      const result = await provider.retrieveCheckoutForm(form.token);
      expect(result.failureReason).toBe('card_declined');
    });

    it('returns failure reason "insufficient_funds" for card 4111111111111111', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      provider.tagFormSession(form.token, { outcome: 'fail', cardNumber: '4111111111111111' });
      const result = await provider.retrieveCheckoutForm(form.token);
      expect(result.failureReason).toBe('insufficient_funds');
    });

    it('returns failure reason "card_expired" for card 4111111111111100', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      provider.tagFormSession(form.token, { outcome: 'fail', cardNumber: '4111111111111100' });
      const result = await provider.retrieveCheckoutForm(form.token);
      expect(result.failureReason).toBe('card_expired');
    });

    it('returns declined even on success outcome for declined card number', async () => {
      const form = await provider.initCheckoutForm({
        paymentId: 'pay_1',
        amount: 10000,
        currency: 'TRY',
        callbackUrl: 'https://example.com/callback',
      });

      // Even with outcome=success, the card number check kicks in
      provider.tagFormSession(form.token, { outcome: 'success', cardNumber: '4111111111111129' });
      const result = await provider.retrieveCheckoutForm(form.token);
      expect(result.success).toBe(false);
      expect(result.failureReason).toBe('card_declined');
    });
  });

  // ─── capture ──────────────────────────────────────────────────────────

  describe('capture()', () => {
    it('succeeds normally', async () => {
      const result = await provider.capture({ providerTxId: 'mock_tx_normal' });
      expect(result.success).toBe(true);
    });

    it('throws for providerTxId === "mock_tx_capture_fail"', async () => {
      await expect(
        provider.capture({ providerTxId: 'mock_tx_capture_fail' }),
      ).rejects.toThrow('Capture failed at provider');
    });
  });

  // ─── void ─────────────────────────────────────────────────────────────

  describe('void()', () => {
    it('succeeds normally', async () => {
      const result = await provider.void({ providerTxId: 'mock_tx_normal' });
      expect(result.success).toBe(true);
    });

    it('throws for providerTxId === "mock_tx_void_fail"', async () => {
      await expect(
        provider.void({ providerTxId: 'mock_tx_void_fail' }),
      ).rejects.toThrow('Void failed at provider');
    });
  });

  // ─── refund ───────────────────────────────────────────────────────────

  describe('refund()', () => {
    it('succeeds normally', async () => {
      const result = await provider.refund({ providerTxId: 'mock_tx_normal' });
      expect(result.success).toBe(true);
    });

    it('throws for providerTxId === "mock_tx_refund_fail"', async () => {
      await expect(
        provider.refund({ providerTxId: 'mock_tx_refund_fail' }),
      ).rejects.toThrow('Refund failed at provider');
    });
  });
});
