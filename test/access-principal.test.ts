import { GetRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credentialMocks = vi.hoisted(() => ({
  fromNodeProviderChain: vi.fn(() => async () => ({ accessKeyId: 'test-only', secretAccessKey: 'test-only' })),
}));

vi.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: credentialMocks.fromNodeProviderChain }));

import { resolveAccessPrincipal } from '../lib/access-principal.js';

const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const account = '123456789012';
const userArn = `arn:aws:iam::${account}:user/developers/demo`;
const roleName = 'AWSReservedSSO_Developer_0123456789abcdef';
const sessionArn = `arn:aws:sts::${account}:assumed-role/${roleName}/demo-session`;
const roleArn = `arn:aws:iam::${account}:role/aws-reserved/sso.amazonaws.com/eu-west-1/${roleName}`;

beforeEach(() => {
  sts.reset();
  iam.reset();
  vi.clearAllMocks();
  vi.stubEnv('AWS_PROFILE', '');
  vi.stubEnv('AWS_ACCESS_KEY_ID', '');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OpenSearch access principal discovery', () => {
  it('rejects competing environment credentials and a profile without contacting AWS', async () => {
    vi.stubEnv('AWS_PROFILE', 'demo');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-only');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-only');

    await expect(resolveAccessPrincipal('eu-west-1')).rejects.toThrow(
      'Use either exported credentials or AWS_PROFILE consistently',
    );

    expect(credentialMocks.fromNodeProviderChain).not.toHaveBeenCalled();
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
  });

  it.each([userArn, roleArn])('uses the IAM principal %s directly without a role lookup', async (arn) => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: arn });

    await expect(resolveAccessPrincipal('eu-west-1', account)).resolves.toBe(arn);

    expect(credentialMocks.fromNodeProviderChain).toHaveBeenCalledExactlyOnceWith();
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(1);
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
  });

  it('resolves an assumed role to its complete SSO IAM path', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: sessionArn });
    iam
      .on(GetRoleCommand)
      .resolves({ Role: { Arn: roleArn, RoleName: roleName, RoleId: 'role-id', Path: '/', CreateDate: new Date(0) } });

    await expect(resolveAccessPrincipal('eu-west-1', account)).resolves.toBe(roleArn);

    expect(iam.commandCalls(GetRoleCommand)[0]!.args[0].input).toEqual({ RoleName: roleName });
  });

  it('discovers the caller when CDK has not supplied an expected account', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: userArn });

    await expect(resolveAccessPrincipal('eu-west-1')).resolves.toBe(userArn);
  });

  it('rejects different CDK and app accounts before resolving a role', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: sessionArn });

    await expect(resolveAccessPrincipal('eu-west-1', '999999999999')).rejects.toThrow(
      'Set the same AWS_PROFILE for CDK, the app, and the lab runtime',
    );
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
  });

  it.each([
    `arn:aws:iam::${account}:root`,
    `arn:aws:sts::${account}:federated-user/demo`,
    `arn:aws:iam::999999999999:user/demo`,
    `arn:aws:sts::999999999999:assumed-role/Demo/session`,
  ])('rejects unsupported or inconsistent caller identity %s', async (arn) => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: arn });

    await expect(resolveAccessPrincipal('eu-west-1')).rejects.toThrow('Deploy using IAM user or role credentials');
    expect(iam.commandCalls(GetRoleCommand)).toHaveLength(0);
  });

  it('explains the required permission when the complete role ARN cannot be resolved', async () => {
    const denied = Object.assign(new Error('Access denied'), { name: 'AccessDenied' });
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: sessionArn });
    iam.on(GetRoleCommand).rejects(denied);

    await expect(resolveAccessPrincipal('eu-west-1')).rejects.toThrow('needs iam:GetRole on its own role');
  });

  it.each([
    `arn:aws:iam::999999999999:role/${roleName}`,
    `arn:aws:iam::${account}:role/DifferentRole`,
    `arn:aws-cn:iam::${account}:role/${roleName}`,
  ])('rejects a role lookup that does not match the caller: %s', async (arn) => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: account, Arn: sessionArn });
    iam
      .on(GetRoleCommand)
      .resolves({ Role: { Arn: arn, RoleName: roleName, RoleId: 'role-id', Path: '/', CreateDate: new Date(0) } });

    await expect(resolveAccessPrincipal('eu-west-1')).rejects.toThrow('matching role ARN in the caller account');
  });
});
