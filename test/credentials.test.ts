import { beforeEach, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => {
  const fetch = vi.fn();
  return { fetch, fromNodeProviderChain: vi.fn(() => fetch) };
});

vi.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: provider.fromNodeProviderChain }));

import { awsConfig } from '../src/config.js';
import { configSchema } from '../src/types.js';
import { config } from './fixtures.js';

beforeEach(() => {
  vi.clearAllMocks();
});

it('uses the default AWS credential chain without assuming a separate lab role', async () => {
  const identity = {
    accessKeyId: 'test-only',
    secretAccessKey: 'test-only',
    sessionToken: 'test-only',
    expiration: new Date(Date.now() + 3600000),
  };
  provider.fetch.mockResolvedValue(identity);

  const clientConfig = awsConfig({ ...config }, 1);

  expect(provider.fromNodeProviderChain).toHaveBeenCalledExactlyOnceWith();
  expect(provider.fetch).not.toHaveBeenCalled();
  expect(clientConfig).toMatchObject({ region: 'eu-west-1', maxAttempts: 1, retryMode: 'standard' });
  await expect(clientConfig.credentials()).resolves.toBe(identity);
});

it('shares one SDK credential provider across clients using the same lab configuration', () => {
  const labConfig = { ...config };
  const signingConfig = awsConfig(labConfig);
  const clientConfig = awsConfig(labConfig);

  expect(signingConfig.credentials).toBe(clientConfig.credentials);
  expect(provider.fromNodeProviderChain).toHaveBeenCalledTimes(1);
});

it('accepts deployment outputs without a lab role ARN', () => {
  expect(configSchema.parse(config)).toEqual(config);
});
