module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Infrastructure — overridden in docker-compose for container networking
  databaseUrl: process.env.DATABASE_URL,
  rabbitmqUrl: process.env.RABBITMQ_URL,

  // App config — all from .env, no competing defaults
  paymentProvider: process.env.PAYMENT_PROVIDER,
  skipAuth: process.env.SKIP_AUTH === 'true',
  jwtSecret: process.env.JWT_SECRET,
  apiBaseUrl: process.env.API_BASE_URL,

  // iyzico
  iyzicoApiKey: process.env.IYZICO_API_KEY,
  iyzicoSecretKey: process.env.IYZICO_SECRET_KEY,
  iyzicoBaseUrl: process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com',
};
