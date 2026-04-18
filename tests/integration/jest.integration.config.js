module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.integration.test.js'],
  globalSetup: '<rootDir>/globalSetup.js',
  globalTeardown: '<rootDir>/globalTeardown.js',
  setupFilesAfterEnv: ['<rootDir>/setupEnv.js'],
  testTimeout: 60000,
  moduleNameMapper: {
    '^uuid$': '<rootDir>/../__mocks__/uuid.js',
  },
};
