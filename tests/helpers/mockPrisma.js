/**
 * Shared Prisma mock factory.
 * Each test file should call jest.mock('../../src/lib/prisma', () => require('../helpers/mockPrisma'));
 */
const mockPrisma = {
  payment: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  },
  paymentEvent: {
    create: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
};

module.exports = mockPrisma;
