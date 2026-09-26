import { Region, Stage } from './types';
import { EnvironmentConfig, getEnvironmentConfig } from './environment-config';

export interface PipelineConfig {
  repoName: string;
  gitHubConnectionArn: string;
  pipelineName: string; // Name of the pipeline stack
  stackNamePrefix: string; // Prefix for the Pipeline stack names - specified so we have a predictable role name
  pipelineAccount: string;
  pipelineRegion: string;
  pipelines: {
    envConfig: EnvironmentConfig;
    branch: string;
    preApproval: boolean; // Require approval before Create Change Set
  }[];
}

/**
 * Configuration object for defining the pipeline setup.
 *
 * @constant
 * @type {PipelineConfig}
 *
 * @property {string} repoName - The name of the repository associated with the pipeline.
 * @property {string} gitHubConnectionArn - The ARN of the GitHub connection used for the pipeline.
 * @property {string} pipelineName - The name of the pipeline.
 * @property {string} stackNamePrefix - The prefix for stack names created by the pipeline.
 * @property {string} pipelineAccount - The AWS account ID where the pipeline is hosted.
 * @property {Region} pipelineRegion - The primary region where the pipeline operates.
 * @property {Array<Object>} pipelines - An array of pipeline stage configurations.
 *
 * Each pipeline stage configuration includes:
 * - `envConfig` (EnvironmentConfig): The environment-specific configuration for the stage.
 * - `branch` (string): The branch in the repository associated with the stage.
 * - `preApproval` (boolean): Indicates whether manual approval is required before deployment.
 */
export const pipelineConfig: PipelineConfig = {
  repoName: 'Crockwell-Solutions/flights-service',
  gitHubConnectionArn: 'arn:aws:codeconnections:eu-west-1:606065958605:connection/d820a3fc-b8e5-4e8a-bd05-97b97a7a659b',
  pipelineName: 'FlightsServicePipeline',
  stackNamePrefix: 'Pipeline',
  pipelineAccount: '606065958605',
  pipelineRegion: Region.primary,
  pipelines: [
    {
      envConfig: getEnvironmentConfig(Stage.dev),
      branch: 'main',
      preApproval: false,
    },
  ],
};
