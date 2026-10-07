import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { memoize } from '@smithy/property-provider';
import { configSchema, type LabConfig } from './types.js';
import { readJson } from './io.js';
export async function loadConfig(file: string): Promise<LabConfig> {
  const data = await readJson(file);
  const direct = configSchema.safeParse(data);
  if (direct.success) return direct.data;
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (value && typeof value === 'object' && 'LabConfig' in value && typeof value.LabConfig === 'string')
        return configSchema.parse(JSON.parse(value.LabConfig));
    }
  }
  throw new Error(`No LabConfig in ${file}. Run npm run deploy or pass --config with a saved configuration.`);
}
type CredentialIdentity = Awaited<ReturnType<ReturnType<typeof fromTemporaryCredentials>>>;
const providers = new WeakMap<LabConfig, () => Promise<CredentialIdentity>>();
export function awsConfig(config: LabConfig, maxAttempts = 3) {
  let credentials = providers.get(config);
  if (!credentials) {
    credentials = memoize(
      fromTemporaryCredentials({
        masterCredentials: fromNodeProviderChain(),
        clientConfig: { region: config.region },
        params: { RoleArn: config.roleArn, RoleSessionName: 'vector-lab' },
      }),
      (value) => !!value.expiration && value.expiration.getTime() - Date.now() < 300_000,
      (value) => !!value.expiration,
    );
    providers.set(config, credentials);
  }
  return { region: config.region, credentials, maxAttempts, retryMode: 'standard' as const };
}
