/*
 * CDK Stack - Stateful Resources
 *
 * This CDK stack sets up the stateful backend resources for the CDK Serverless Vector Stores Project.
 * This contains the DynamoDB table(s)
 *
 * Copyright Crockwell Solutions Limited
 */

import { Stack, StackProps, Aspects } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { EnvironmentConfig, Stage, getRemovalPolicyFromStage } from '../../config';
import { AttributeType, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { CustomTable } from '../constructs/custom-table';

export interface StatefulStackProps extends StackProps {
  stage: Stage;
  envConfig: EnvironmentConfig;
}

export class StatefulStack extends Stack {
  // Exports from this stack
  public readonly table: Table;

  constructor(scope: Construct, id: string, props: StatefulStackProps) {
    super(scope, id, props);

    // Define a DynamoDB table that will be used to store the main data
    this.table = new CustomTable(this, `${props.envConfig.project}Table`, {
      tableName: 'Table',
      stageName: props.stage,
      removalPolicy: getRemovalPolicyFromStage(props.stage),
      partitionKey: {
        name: 'PK',
        type: AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: AttributeType.STRING,
      },
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      replicationRegions: props.envConfig.regions.filter((region) => region !== this.region),
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: {
            name: 'GSI1PK',
            type: AttributeType.STRING,
          },
          sortKey: {
            name: 'GSI1SK',
            type: AttributeType.STRING,
          },
          projectionType: ProjectionType.ALL,
        },
      ],
    }).table;

    // cdk nag check and suppressions
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CDK-managed DynamoDB replica provider requires wildcard permissions to manage global table replicas and indexes across configured regions',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'CDK-managed DynamoDB replica provider runtime is controlled by aws-cdk-lib',
        },
        {
          id: 'AwsSolutions-SF1',
          reason:
            'CDK-managed DynamoDB replica provider waiter state machine is not application workflow infrastructure',
        },
        {
          id: 'AwsSolutions-SF2',
          reason:
            'CDK-managed DynamoDB replica provider waiter state machine is not application workflow infrastructure',
        },
      ],
      true,
    );
  }
}
