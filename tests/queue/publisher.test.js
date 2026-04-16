jest.mock('../../src/config', () => ({
  rabbitmqUrl: 'amqp://localhost',
}));

const mockChannel = {
  assertExchange: jest.fn().mockResolvedValue({}),
  publish: jest.fn().mockReturnValue(true),
  close: jest.fn().mockResolvedValue(undefined),
};

const mockConnection = {
  createChannel: jest.fn().mockResolvedValue(mockChannel),
  close: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};

jest.mock('amqplib', () => ({
  connect: jest.fn().mockResolvedValue(mockConnection),
}));

const amqp = require('amqplib');

describe('publisher', () => {
  let publisher;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module state for each test
    jest.resetModules();

    // Re-mock after resetModules
    jest.mock('../../src/config', () => ({
      rabbitmqUrl: 'amqp://localhost',
    }));

    jest.mock('amqplib', () => ({
      connect: jest.fn().mockResolvedValue({
        createChannel: jest.fn().mockResolvedValue({
          assertExchange: jest.fn().mockResolvedValue({}),
          publish: jest.fn().mockReturnValue(true),
          close: jest.fn().mockResolvedValue(undefined),
        }),
        close: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      }),
    }));

    publisher = require('../../src/queue/publisher');
  });

  describe('connect()', () => {
    it('creates connection, channel, asserts exchange "payment.events" with type "topic"', async () => {
      const amqpMock = require('amqplib');

      await publisher.connect();

      expect(amqpMock.connect).toHaveBeenCalled();
      const connection = await amqpMock.connect.mock.results[0].value;
      expect(connection.createChannel).toHaveBeenCalled();
      const channel = await connection.createChannel.mock.results[0].value;
      expect(channel.assertExchange).toHaveBeenCalledWith('payment.events', 'topic', { durable: true });
    });
  });

  describe('publish(routingKey, payload)', () => {
    it('publishes to exchange with persistent: true, returns true', async () => {
      const amqpMock = require('amqplib');
      await publisher.connect();

      const connection = await amqpMock.connect.mock.results[0].value;
      const channel = await connection.createChannel.mock.results[0].value;

      const result = publisher.publish('payment.captured', { paymentId: 'pay_1' });

      expect(result).toBe(true);
      expect(channel.publish).toHaveBeenCalledWith(
        'payment.events',
        'payment.captured',
        expect.any(Buffer),
        { persistent: true },
      );
    });

    it('returns false when channel is null (logs warning)', async () => {
      // Don't connect – channel remains null
      const result = publisher.publish('payment.captured', { paymentId: 'pay_1' });

      expect(result).toBe(false);
    });
  });

  describe('isConnected()', () => {
    it('returns true after successful connect', async () => {
      expect(publisher.isConnected()).toBe(false);

      await publisher.connect();

      expect(publisher.isConnected()).toBe(true);
    });

    it('returns false initially', () => {
      expect(publisher.isConnected()).toBe(false);
    });
  });

  describe('close()', () => {
    it('closes channel and connection', async () => {
      const amqpMock = require('amqplib');
      await publisher.connect();

      const connection = await amqpMock.connect.mock.results[0].value;
      const channel = await connection.createChannel.mock.results[0].value;

      await publisher.close();

      expect(channel.close).toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalled();
      expect(publisher.isConnected()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('sets connected = false on connect failure', async () => {
      jest.resetModules();

      jest.mock('../../src/config', () => ({
        rabbitmqUrl: 'amqp://localhost',
      }));

      jest.mock('amqplib', () => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
      }));

      // Use fake timers to prevent the setTimeout reconnect from firing
      jest.useFakeTimers();

      const failPublisher = require('../../src/queue/publisher');

      await failPublisher.connect();

      expect(failPublisher.isConnected()).toBe(false);

      jest.useRealTimers();
    });

    it('connection "error" event sets connected = false', async () => {
      const amqpMock = require('amqplib');
      await publisher.connect();
      expect(publisher.isConnected()).toBe(true);

      const connection = await amqpMock.connect.mock.results[0].value;

      // Find the 'error' handler that was registered and invoke it
      const errorCall = connection.on.mock.calls.find(([event]) => event === 'error');
      expect(errorCall).toBeDefined();
      const errorHandler = errorCall[1];

      errorHandler(new Error('test connection error'));

      expect(publisher.isConnected()).toBe(false);
    });

    it('connection "close" event sets connected = false and schedules reconnect', async () => {
      jest.useFakeTimers();

      const amqpMock = require('amqplib');
      await publisher.connect();
      expect(publisher.isConnected()).toBe(true);

      const connection = await amqpMock.connect.mock.results[0].value;

      // Find the 'close' handler that was registered and invoke it
      const closeCall = connection.on.mock.calls.find(([event]) => event === 'close');
      expect(closeCall).toBeDefined();
      const closeHandler = closeCall[1];

      closeHandler();

      expect(publisher.isConnected()).toBe(false);

      jest.useRealTimers();
    });
  });
});
