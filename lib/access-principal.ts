import { GetRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

/**
 * Resolve the current credentials to the durable IAM principal required by OpenSearch data access.
 * STS session ARNs omit role paths, so GetRole recovers the full ARN for SSO and other assumed roles.
 */
export async function resolveAccessPrincipal(region: string, expectedAccount?: string): Promise<string> {
  // CDK and the SDK prioritize these two credential sources differently when both are present.
  if (process.env.AWS_PROFILE && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      'Both AWS_PROFILE and exported AWS credentials are set. Use either exported credentials or AWS_PROFILE consistently for CDK and the lab runtime, not both.',
    );
  }

  const options = { region, credentials: fromNodeProviderChain() };
  const sts = new STSClient(options);
  const iam = new IAMClient(options);

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));

    // CDK and the app must discover the same account before an access policy is synthesized.
    if (expectedAccount && identity.Account !== expectedAccount) {
      throw new Error(
        `The CDK target account (${expectedAccount}) does not match the app credentials (${identity.Account ?? 'unknown'}). ` +
          'Set the same AWS_PROFILE for CDK, the app, and the lab runtime, or use matching terminal credentials.',
      );
    }

    const arn = identity.Arn ?? '';
    const direct = /^arn:([^:]+):iam::([0-9]{12}):(user|role)\/.+$/.exec(arn);

    if (direct && direct[2] === identity.Account) {
      return arn;
    }

    const session = /^arn:([^:]+):sts::([0-9]{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(arn);
    if (!session || session[2] !== identity.Account) {
      throw new Error(
        'Deploy using IAM user or role credentials. Root and federated-user sessions cannot be used as the lab OpenSearch principal.',
      );
    }

    const roleName = session[3]!;
    let roleArn: string | undefined;
    try {
      roleArn = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role?.Arn;
    } catch (error) {
      throw new Error(
        `Cannot resolve IAM role ${roleName}. The deployment identity needs iam:GetRole on its own role to discover the full ARN.`,
        { cause: error },
      );
    }

    const prefix = `arn:${session[1]}:iam::${identity.Account}:role/`;
    if (!roleArn?.startsWith(prefix) || roleArn.split('/').at(-1) !== roleName) {
      throw new Error('IAM GetRole did not return a matching role ARN in the caller account.');
    }

    return roleArn;
  } finally {
    sts.destroy();
    iam.destroy();
  }
}
