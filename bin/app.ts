#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { resolveAccessPrincipal } from '../lib/access-principal.js';
import { VectorLabStack } from '../lib/vector-lab-stack.js';

const app = new App();
const region: string = app.node.tryGetContext('region') ?? 'eu-west-1';
const offline = ['true', true].includes(app.node.tryGetContext('offline'));

// OpenSearch needs the caller's IAM ARN in addition to normal IAM permissions.
// Offline synthesis leaves it as a required parameter, so no fabricated identity can be deployed.
const accessPrincipalArn = offline ? undefined : await resolveAccessPrincipal(region, process.env.CDK_DEFAULT_ACCOUNT);

new VectorLabStack(app, 'VectorLab', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  accessPrincipalArn,
  description: 'AWS serverless vector store comparison',
});
