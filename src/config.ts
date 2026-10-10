import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { configSchema, type LabConfig } from './types.js';
import { readJson } from './io.js';

/**
 * Load either a saved lab configuration or the serialized LabConfig in CDK stack outputs.
 */
export async function loadConfig(file: string): Promise<LabConfig> {
  const data = await readJson(file);
  const direct = configSchema.safeParse(data);
  if (direct.success) {
    return direct.data;
  }

  // CDK outputs group each stack's output values under its stack name.
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (value && typeof value === 'object' && 'LabConfig' in value && typeof value.LabConfig === 'string') {
        return configSchema.parse(JSON.parse(value.LabConfig));
      }
    }
  }

  throw new Error(`No LabConfig in ${file}. Run npm run deploy or pass --config with a saved configuration.`);
}

// Share the SDK's cached, refreshable credential provider across clients and request signing.
const providers = new WeakMap<LabConfig, ReturnType<typeof fromNodeProviderChain>>();

/**
 * Configure regional AWS clients using credentials from the normal SDK provider chain.
 * This supports terminal environment variables, AWS profiles, and workload credentials.
 */
export function awsConfig(config: LabConfig, maxAttempts = 3) {
  let credentials = providers.get(config);
  if (!credentials) {
    credentials = fromNodeProviderChain();
    providers.set(config, credentials);
  }

  return { region: config.region, credentials, maxAttempts, retryMode: 'standard' as const };
}
