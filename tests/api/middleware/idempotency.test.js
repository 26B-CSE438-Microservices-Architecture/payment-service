jest.mock('../../../src/lib/prisma', () => require('../../helpers/mockPrisma'));

const idempotencyMiddleware = require('../../../src/api/middleware/idempotency');

describe('idempotencyMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('sets req.idempotencyKey and calls next() when Idempotency-Key header is present', () => {
    req.headers['idempotency-key'] = 'idem-abc-123';

    idempotencyMiddleware(req, res, next);

    expect(req.idempotencyKey).toBe('idem-abc-123');
    expect(next).toHaveBeenCalled();
  });

  it('returns 400 with MISSING_IDEMPOTENCY_KEY error when header is missing', () => {
    idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
      }),
    });
    expect(next).not.toHaveBeenCalled();
  });
});
