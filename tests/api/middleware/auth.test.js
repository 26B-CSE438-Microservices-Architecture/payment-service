const config = require('../../../src/config');

// We directly require authMiddleware once (it reads config at call-time, not at require-time)
const authMiddleware = require('../../../src/api/middleware/auth');

describe('authMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      headers: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  // ─── SKIP_AUTH mode ───────────────────────────────────────────────────

  describe('SKIP_AUTH mode (config.skipAuth = true)', () => {
    beforeEach(() => {
      config.skipAuth = true;
    });

    it('sets req.userId from X-User-Id header and calls next()', () => {
      req.headers['x-user-id'] = 'user-123';

      authMiddleware(req, res, next);

      expect(req.userId).toBe('user-123');
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 with UNAUTHORIZED when X-User-Id is missing', () => {
      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── JWT mode ─────────────────────────────────────────────────────────

  describe('JWT mode (config.skipAuth = false)', () => {
    let jwt;

    beforeEach(() => {
      config.skipAuth = false;
      // Get the same jwt reference that auth.js is using
      jwt = require('jsonwebtoken');
    });

    afterEach(() => {
      config.skipAuth = true; // restore default test value
    });

    it('decodes a valid JWT and sets req.userId = decoded.sub, calls next()', () => {
      req.headers.authorization = 'Bearer valid-token-123';
      // Spy on verify to control its return value
      const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({ sub: 'user-456' });

      authMiddleware(req, res, next);

      expect(verifySpy).toHaveBeenCalledWith('valid-token-123', config.jwtSecret);
      expect(req.userId).toBe('user-456');
      expect(next).toHaveBeenCalled();

      verifySpy.mockRestore();
    });

    it('returns 401 when Authorization header is missing', () => {
      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization header does not start with "Bearer "', () => {
      req.headers.authorization = 'Basic some-credentials';

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when JWT is invalid/expired', () => {
      req.headers.authorization = 'Bearer expired-token';
      const verifySpy = jest.spyOn(jwt, 'verify').mockImplementation(() => {
        throw new Error('jwt expired');
      });

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
      });
      expect(next).not.toHaveBeenCalled();

      verifySpy.mockRestore();
    });
  });
});
