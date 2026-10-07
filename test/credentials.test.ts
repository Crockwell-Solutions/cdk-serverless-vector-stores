import { expect, it, vi } from 'vitest';
const provider = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => vi.fn(),
  fromTemporaryCredentials: () => provider.fetch,
}));
import { awsConfig } from '../src/config.js';
import { config } from './fixtures.js';
it('shares and memoizes STS credentials across signing and SDK clients', async () => {
  provider.fetch.mockResolvedValue({
    accessKeyId: 'test-only',
    secretAccessKey: 'test-only',
    expiration: new Date(Date.now() + 3600000),
  });
  const a = awsConfig({ ...config });
  await Promise.all([a.credentials(), a.credentials(), a.credentials()]);
  await a.credentials();
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  const b = awsConfig(config),
    c = awsConfig(config);
  expect(b.credentials).toBe(c.credentials);
});
