const jwt = require('jsonwebtoken');
const config = require('../../config');

function authMiddleware(req, res, next) {
  if (config.skipAuth) {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'X-User-Id header is required when SKIP_AUTH is enabled' },
      });
    }
    req.userId = userId;
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
    });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.userId = decoded.sub;
    next();
  } catch (err) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    });
  }
}

module.exports = authMiddleware;
