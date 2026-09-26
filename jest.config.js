/**
 * Jest configuration for the root (CDK infrastructure) project.
 *
 * The frontend uses Vitest (see frontend/vitest.config.ts) so its
 * tests and the frontend workspace are excluded from the root test run.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/bin', '<rootDir>/lib', '<rootDir>/src', '<rootDir>/config'],
  testPathIgnorePatterns: ['/node_modules/', '/cdk.out/', '/frontend/', '/dist/'],
  modulePathIgnorePatterns: ['/cdk.out/', '/frontend/', '/dist/'],
  moduleNameMapper: {
    '^@config$': '<rootDir>/config/index.ts',
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@constructs$': '<rootDir>/lib/constructs/index.ts',
    '^@constructs/(.*)$': '<rootDir>/lib/constructs/$1',
    '^@shared$': '<rootDir>/src/shared/index.ts',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
  },
  passWithNoTests: true,
};
