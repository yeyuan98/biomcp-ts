export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.json',
      diagnostics: false,
    }],
  },
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  // Integration suites hit live APIs and run via jest.integration.config.ts
  // (`npm run test:integration`); exclude them from the default unit run here
  // so a bare `npx jest` never picks them up. '/node_modules/' is Jest's
  // default, restated because setting this option replaces the default.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/__tests__/integration'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage/unit',
};
