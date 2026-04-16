/**
 * Shared publisher mock factory.
 * Each test file should call jest.mock('../../src/queue/publisher', () => require('../helpers/mockPublisher'));
 */
const mockPublisher = {
  connect: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn(),
  isConnected: jest.fn().mockReturnValue(true),
  close: jest.fn().mockResolvedValue(undefined),
};

module.exports = mockPublisher;
