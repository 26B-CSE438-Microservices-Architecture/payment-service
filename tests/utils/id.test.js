const { generatePaymentId, generateCardId } = require('../../src/utils/id');

describe('ID Generators', () => {
  describe('generatePaymentId()', () => {
    it('returns a string starting with "pay_" followed by a UUID', () => {
      const id = generatePaymentId();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^pay_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('each call returns a unique value', () => {
      const id1 = generatePaymentId();
      const id2 = generatePaymentId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateCardId()', () => {
    it('returns a string starting with "card_" followed by a UUID', () => {
      const id = generateCardId();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^card_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('each call returns a unique value', () => {
      const id1 = generateCardId();
      const id2 = generateCardId();
      expect(id1).not.toBe(id2);
    });
  });
});
