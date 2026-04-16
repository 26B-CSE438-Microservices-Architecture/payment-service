describe('providers/index - createProvider()', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('returns MockProvider instance when config.paymentProvider === "mock"', () => {
    jest.mock('../../src/config', () => ({
      paymentProvider: 'mock',
      iyzicoApiKey: 'test',
      iyzicoSecretKey: 'test',
      iyzicoBaseUrl: 'https://sandbox-api.iyzipay.com',
    }));

    const { createProvider } = require('../../src/providers/index');
    const MockProvider = require('../../src/providers/MockProvider');
    const provider = createProvider();
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it('returns IyzicoProvider instance when config.paymentProvider === "iyzico"', () => {
    jest.mock('../../src/config', () => ({
      paymentProvider: 'iyzico',
      iyzicoApiKey: 'test',
      iyzicoSecretKey: 'test',
      iyzicoBaseUrl: 'https://sandbox-api.iyzipay.com',
    }));

    const { createProvider } = require('../../src/providers/index');
    const IyzicoProvider = require('../../src/providers/IyzicoProvider');
    const provider = createProvider();
    expect(provider).toBeInstanceOf(IyzicoProvider);
  });

  it('throws "Unknown provider: X" for any other value', () => {
    jest.mock('../../src/config', () => ({
      paymentProvider: 'stripe',
      iyzicoApiKey: 'test',
      iyzicoSecretKey: 'test',
      iyzicoBaseUrl: 'https://sandbox-api.iyzipay.com',
    }));

    const { createProvider } = require('../../src/providers/index');
    expect(() => createProvider()).toThrow('Unknown provider: stripe');
  });
});
