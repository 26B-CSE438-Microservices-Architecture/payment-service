const {
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  assertTransition,
  isTerminal,
} = require('../../src/core/PaymentStateMachine');

describe('PaymentStateMachine', () => {
  // ─── canTransition ────────────────────────────────────────────────────

  describe('canTransition(from, to)', () => {
    const validCases = [
      ['CREATED', 'AWAITING_FORM'],
      ['CREATED', 'AUTHORIZED'],
      ['CREATED', 'FAILED'],
      ['AWAITING_FORM', 'AUTHORIZED'],
      ['AWAITING_FORM', 'FAILED'],
      ['AUTHORIZED', 'CAPTURED'],
      ['AUTHORIZED', 'VOIDED'],
      ['CAPTURED', 'REFUNDED'],
    ];

    it.each(validCases)(
      'returns true for valid transition %s → %s',
      (from, to) => {
        expect(canTransition(from, to)).toBe(true);
      },
    );

    const invalidCases = [
      ['CREATED', 'CAPTURED'],
      ['CREATED', 'VOIDED'],
      ['CREATED', 'REFUNDED'],
      ['FAILED', 'AUTHORIZED'],
      ['FAILED', 'CREATED'],
      ['VOIDED', 'CAPTURED'],
      ['VOIDED', 'AUTHORIZED'],
      ['CAPTURED', 'VOIDED'],
      ['CAPTURED', 'AUTHORIZED'],
      ['REFUNDED', 'CREATED'],
      ['REFUNDED', 'CAPTURED'],
      ['AWAITING_FORM', 'CAPTURED'],
      ['AWAITING_FORM', 'VOIDED'],
    ];

    it.each(invalidCases)(
      'returns false for invalid transition %s → %s',
      (from, to) => {
        expect(canTransition(from, to)).toBe(false);
      },
    );

    it('returns false for unknown source status', () => {
      expect(canTransition('UNKNOWN', 'FAILED')).toBe(false);
      expect(canTransition('PENDING', 'AUTHORIZED')).toBe(false);
    });
  });

  // ─── assertTransition ─────────────────────────────────────────────────

  describe('assertTransition(from, to)', () => {
    it('does not throw for valid transitions', () => {
      expect(() => assertTransition('CREATED', 'AWAITING_FORM')).not.toThrow();
      expect(() => assertTransition('AUTHORIZED', 'CAPTURED')).not.toThrow();
      expect(() => assertTransition('CAPTURED', 'REFUNDED')).not.toThrow();
    });

    it('throws an error with code INVALID_STATE_TRANSITION for invalid transitions', () => {
      try {
        assertTransition('CREATED', 'CAPTURED');
        fail('Expected error to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.statusCode).toBe(409);
      }
    });

    it('error message contains both statuses', () => {
      try {
        assertTransition('FAILED', 'AUTHORIZED');
        fail('Expected error to be thrown');
      } catch (err) {
        expect(err.message).toContain('FAILED');
        expect(err.message).toContain('AUTHORIZED');
        expect(err.message).toMatch(/Invalid state transition/);
      }
    });

    it('throws for unknown source status', () => {
      expect(() => assertTransition('UNKNOWN', 'FAILED')).toThrow();
    });
  });

  // ─── isTerminal ───────────────────────────────────────────────────────

  describe('isTerminal(status)', () => {
    it.each(['FAILED', 'VOIDED', 'REFUNDED', 'CAPTURED'])(
      'returns true for terminal status %s',
      (status) => {
        expect(isTerminal(status)).toBe(true);
      },
    );

    it.each(['CREATED', 'AWAITING_FORM', 'AUTHORIZED'])(
      'returns false for non-terminal status %s',
      (status) => {
        expect(isTerminal(status)).toBe(false);
      },
    );
  });

  // ─── Exported constants ───────────────────────────────────────────────

  describe('exported constants', () => {
    it('VALID_TRANSITIONS has the correct keys', () => {
      const expectedKeys = ['CREATED', 'AWAITING_FORM', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'VOIDED', 'REFUNDED'];
      expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual(expectedKeys.sort());
    });

    it('VALID_TRANSITIONS has the correct values for each key', () => {
      expect(VALID_TRANSITIONS.CREATED).toEqual(['AWAITING_FORM', 'AUTHORIZED', 'FAILED']);
      expect(VALID_TRANSITIONS.AWAITING_FORM).toEqual(['AUTHORIZED', 'FAILED']);
      expect(VALID_TRANSITIONS.AUTHORIZED).toEqual(['CAPTURED', 'VOIDED']);
      expect(VALID_TRANSITIONS.CAPTURED).toEqual(['REFUNDED']);
      expect(VALID_TRANSITIONS.FAILED).toEqual([]);
      expect(VALID_TRANSITIONS.VOIDED).toEqual([]);
      expect(VALID_TRANSITIONS.REFUNDED).toEqual([]);
    });

    it('TERMINAL_STATES contains exactly the four terminal states', () => {
      expect(TERMINAL_STATES).toEqual(expect.arrayContaining(['FAILED', 'VOIDED', 'REFUNDED', 'CAPTURED']));
      expect(TERMINAL_STATES).toHaveLength(4);
    });
  });
});
