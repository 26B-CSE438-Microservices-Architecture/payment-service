module.exports = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,
  rabbitmqUrl: process.env.RABBITMQ_URL,
  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
  nodeEnv: process.env.NODE_ENV || 'development',
};
