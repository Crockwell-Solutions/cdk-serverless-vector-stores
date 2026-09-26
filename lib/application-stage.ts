import { Stage, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StatefulStack } from './stateful/stateful-stack';
import { EnvironmentConfig } from '../config';
import { StatelessStack } from './stateless/stateless-stack';
import { FrontendStack } from './frontend/frontend-stack';

/**
 * Represents an application stage that extends the `Stage` class.
 * This stage is responsible for creating and managing the stateful and stateless stacks
 * within the application, ensuring proper dependency order between them.
 * This the application that is deployed by the CodePipeline
 */
export class ApplicationStage extends Stage {
  constructor(scope: Construct, id: string, props: EnvironmentConfig) {
    super(scope, id, props);
    const envConfig = props;

    const statefulStack = new StatefulStack(this, `${envConfig.project}StatefulStack`, {
      stage: envConfig.stage,
      envConfig: envConfig,
      env: {
        account: envConfig.env.account,
        region: envConfig.env.region,
      },
      crossRegionReferences: true,
    });
    Tags.of(statefulStack).add('service', `${envConfig.project}-stateful-resources`);
    Tags.of(statefulStack).add('stage', `${envConfig.stage}`);

    const statelessStack = new StatelessStack(this, `${envConfig.project}StatelessStack`, {
      stage: envConfig.stage,
      envConfig: envConfig,
      table: statefulStack.table,
      env: {
        account: envConfig.env.account,
        region: envConfig.env.region,
      },
      crossRegionReferences: true,
    });
    statelessStack.addDependency(statefulStack);
    Tags.of(statelessStack).add('service', `${envConfig.project}-stateless-resources`);
    Tags.of(statelessStack).add('stage', `${envConfig.stage}`);

    const frontendStack = new FrontendStack(this, `${envConfig.project}FrontendStack`, {
      stage: envConfig.stage,
      envConfig: envConfig,
      userPoolId: envConfig.cognitoUserPoolArn.split('/').pop()!,
      userPoolClientId: envConfig.cognitoUserPoolClientId,
      env: {
        account: envConfig.env.account,
        region: envConfig.env.region,
      },
      crossRegionReferences: true,
    });
    Tags.of(frontendStack).add('service', `${envConfig.project}-frontend-resources`);
    Tags.of(frontendStack).add('stage', `${envConfig.stage}`);
  }
}
