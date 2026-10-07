#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { VectorLabStack } from '../lib/vector-lab-stack.js';
const app = new App();
new VectorLabStack(app, 'VectorLab', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: app.node.tryGetContext('region') ?? 'eu-west-1' },
  description: 'AWS serverless vector store comparison',
});
