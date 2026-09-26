import { RemovalPolicy } from 'aws-cdk-lib';
import { Region, Stage } from '@config/types';

export function getStage(stage: string): string {
  switch (stage) {
    case Stage.prod:
      return Stage.prod;
    case Stage.dev:
      return Stage.dev;
    default:
      return Stage.dev; // return the dev environment if not known
  }
}

export interface EnvironmentConfig {
  env: {
    account: string;
    region: string;
  };
  regions: string[];
  stage: Stage;
  project: string;
  name: string;
  terminationProtection: boolean;
  logLevel: string;
  minifyCodeOnDeployment?: boolean;
  cognitoUserPoolArn: string;
  cognitoUserPoolClientId: string;
  apiDomainName: string;
}

/**
 * Define the default configuration.
 * These configuration options will be used if no environment-specific configuration is provided.
 * e.g. An ephemeral environment
 */
const defaultConfig: EnvironmentConfig = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT as string,
    region: Region.primary,
  },
  regions: [Region.primary, Region.melbourne],
  stage: Stage.dev,
  project: 'Template',
  name: 'Default',
  terminationProtection: false,
  logLevel: 'INFO',
  minifyCodeOnDeployment: false,
  cognitoUserPoolArn: 'xyz',
  cognitoUserPoolClientId: 'xyz',
  apiDomainName: 'xyz',
};

/**
 * Retrieves the environment configuration based on the provided stage.
 *
 * @param stage - The deployment stage for which the environment configuration is required.
 *                It can be one of the following:
 *                - `Stage.dev`: Development environment configuration.
 *                - `Stage.prod`: Production environment configuration.
 *
 * @returns The environment configuration object for the specified stage, including
 *          properties such as account ID, stage name, VPC CIDR, ACM domain, and
 *          optional deployment flags for specific resources.
 *
 * @remarks
 * - The `defaultConfig` is used as the base configuration and is extended with
 *   stage-specific properties.
 * - The `logLevel` is set to `INFO` for the production stage.
 */
export const getEnvironmentConfig = (stage: Stage): EnvironmentConfig => {
  switch (stage) {
    case Stage.local:
      return {
        ...defaultConfig,
        env: {
          ...defaultConfig.env,
        },
        stage: Stage.local,
        name: 'Local',
      };
    case Stage.dev:
      return {
        ...defaultConfig,
        env: {
          ...defaultConfig.env,
          account: '12345678901',
        },
        stage: Stage.dev,
        name: 'Dev',
        cognitoUserPoolClientId: 'xyz',
      };
    case Stage.prod:
      return {
        ...defaultConfig,
        env: {
          ...defaultConfig.env,
          account: '12345678901',
        },
        terminationProtection: true,
        stage: Stage.prod,
        name: 'Prod',
        logLevel: 'INFO',
        cognitoUserPoolClientId: 'xyz',
        apiDomainName: 'xyz',
      };
    default:
      return defaultConfig;
  }
};

export function getRemovalPolicyFromStage(stage: Stage): RemovalPolicy {
  if (stage !== Stage.prod) {
    return RemovalPolicy.DESTROY; // retain the prod resources
  }
  return RemovalPolicy.RETAIN;
}
