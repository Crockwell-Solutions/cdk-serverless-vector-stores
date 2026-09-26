#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack';
import { ApplicationStage } from '../lib/application-stage';
import { Stage, getEnvironmentConfig, pipelineConfig } from '../config';

const app = new App();

pipelineConfig.pipelines.forEach((pipeline) => {
  const envConfig = pipeline.envConfig;

  new PipelineStack(app, `PipelineStack-${envConfig.name}`, {
    description: `${envConfig.name} Pipeline Stack`,
    env: {
      region: pipelineConfig.pipelineRegion,
      account: pipelineConfig.pipelineAccount,
    },
    repoName: pipelineConfig.repoName,
    gitHubConnectionArn: pipelineConfig.gitHubConnectionArn,
    envConfig: envConfig,
    branch: pipeline.branch,
    preApproval: pipeline.preApproval,
  });
});

new ApplicationStage(app, 'Local', getEnvironmentConfig(Stage.local));
