jest.mock('../../../src/config', () => ({
  nodeEnv: 'test',
}));

const errorHandler = require('../../../src/api/middleware/errorHandler');

describe('errorHandler middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  // ─── Known error code mappings ────────────────────────────────────────

  const codeMappings = [
    ['PAYMENT_NOT_FOUND', 404],
    ['INVALID_STATE_TRANSITION', 409],
    ['CONCURRENT_MODIFICATION', 409],
    ['AMOUNT_MISMATCH', 400],
    ['MISSING_IDEMPOTENCY_KEY', 400],
    ['UNAUTHORIZED', 401],
    ['CHECKOUT_FORM_INIT_FAILED', 502],
    ['MISSING_FORM_TOKEN', 400],
  ];

  it.each(codeMappings)(
    'maps error code %s to HTTP status %d',
    (code, expectedStatus) => {
      const err = new Error(`Test error: ${code}`);
      err.code = code;

      errorHandler(err, req, res, next);

      expect(res.status).toHaveBeenCalledWith(expectedStatus);
      expect(res.json).toHaveBeenCalledWith({
        error: { code, message: err.message },
      });
    },
  );

  it('returns 500 with generic "Internal server error" message for unknown error codes', () => {
    const err = new Error('Something went wrong');
    err.code = 'SOMETHING_UNKNOWN';

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'SOMETHING_UNKNOWN', message: 'Internal server error' },
    });
  });

  it('returns 500 for errors with no code', () => {
    const err = new Error('Unexpected error');

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('uses err.statusCode when present (overrides code-based mapping)', () => {
    const err = new Error('Custom status error');
    err.code = 'PAYMENT_NOT_FOUND'; // would normally be 404
    err.statusCode = 422; // override

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'PAYMENT_NOT_FOUND', message: 'Custom status error' },
    });
  });

  it('returns JSON in { error: { code, message } } format', () => {
    const err = new Error('Test message');
    err.code = 'AMOUNT_MISMATCH';

    errorHandler(err, req, res, next);

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg).toHaveProperty('error');
    expect(jsonArg.error).toHaveProperty('code');
    expect(jsonArg.error).toHaveProperty('message');
  });
});
