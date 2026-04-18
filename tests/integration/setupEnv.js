process.env.JWT_SECRET = 'test-secret';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.SKIP_AUTH = 'true';
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';

jest.mock('../../src/queue/publisher', () => require('../helpers/mockPublisher'));
