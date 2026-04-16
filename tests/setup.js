// Set environment variables before any module is loaded
process.env.JWT_SECRET = 'test-secret';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.SKIP_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.RABBITMQ_URL = 'amqp://localhost';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
