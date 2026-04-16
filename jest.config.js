module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  modulePathIgnorePatterns: ['node_modules', 'prisma'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  // uuid v13+ ships ESM-only — map it to our CJS-compatible mock
  moduleNameMapper: {
    '^uuid$': '<rootDir>/tests/__mocks__/uuid.js',
  },
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/worker/index.js',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
