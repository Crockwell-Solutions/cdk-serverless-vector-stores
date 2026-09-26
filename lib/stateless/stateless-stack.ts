/*
 * CDK Stack - Stateless Resources
 *
 * This CDK stack sets up the stateless backend resources for the CDK Serverless Vector Stores Project.
 * This contains the APIs, Lambda functions and event driven resources
 *
 * Copyright Crockwell Solutions Limited
 */

import { Stack, StackProps, CfnOutput, Aspects } from 'aws-cdk-lib/core';
import {
  RestApi,
  Cors,
  LambdaIntegration,
  AuthorizationType,
  MethodOptions,
  CognitoUserPoolsAuthorizer,
  EndpointType,
} from 'aws-cdk-lib/aws-apigateway';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { UserPool, IUserPool } from 'aws-cdk-lib/aws-cognito';
import { CustomLambda } from '../constructs/custom-lambda';
import { Construct } from 'constructs';
import { EnvironmentConfig, Stage } from '@config';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';

export interface StatelessStackProps extends StackProps {
  stage: Stage;
  envConfig: EnvironmentConfig;
  table: Table;
}

export class StatelessStack extends Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: StatelessStackProps) {
    super(scope, id, props);

    // API Gateway
    const api = new RestApi(this, `${props.envConfig.project}Api`, {
      restApiName: `${props.envConfig.project} API`,
      description: `API for ${props.envConfig.project}`,
      deployOptions: {
        stageName: 'prod',
      },
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: Cors.ALL_METHODS,
      },
    });

    // Lambda: GET /health
    const healthcheck = new CustomLambda(this, 'HealthcheckFunction', {
      functionName: 'HealthcheckFunction',
      source: 'src/api/healthcheck.ts',
      envConfig: props.envConfig,
      environmentVariables: {
        TABLE_NAME: props.table.tableName,
      },
    }).lambda;
    props.table.grantReadData(healthcheck);

    // API Gateway resources
    const healthResource = api.root.addResource('health');

    // Import the cross-account Cognito User Pool by ARN
    const userPool: IUserPool = UserPool.fromUserPoolArn(this, 'ImportedUserPool', props.envConfig.cognitoUserPoolArn);

    // Cognito authorizer for API Gateway
    const cognitoAuthorizer = new CognitoUserPoolsAuthorizer(this, 'FlightsServiceCognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'FlightsServiceCognitoAuthorizer',
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const authorizedMethodOptions: MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: AuthorizationType.COGNITO,
    };

    healthResource.addMethod('GET', new LambdaIntegration(healthcheck), {
      authorizationType: AuthorizationType.NONE,
    });

    this.apiUrl = api.url;

    new CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: `${props.envConfig.project} API URL`,
    });

    // cdk nag check and suppressions
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));
    NagSuppressions.addStackSuppressions(
      this,
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'Lambda functions use the latest runtime are being used',
        },
        {
          id: 'AwsSolutions-APIG1',
          reason: 'Access logging is disabled for API Gateway',
        },
        {
          id: 'AwsSolutions-APIG2',
          reason: 'Logging is disabled for API Gateway',
        },
        {
          id: 'AwsSolutions-APIG3',
          reason: 'No WAF required',
        },
        {
          id: 'AwsSolutions-APIG4',
          reason: 'API Gateway methods are secured with Cognito User Pool authorizer',
        },
        {
          id: 'AwsSolutions-APIG6',
          reason: 'Logging is disabled for API Gateway',
        },
        {
          id: 'AwsSolutions-COG4',
          reason: 'API Gateway methods are secured with Cognito User Pool authorizer',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Accepted use of AWS managed policies',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Accepted use of AWS managed policies',
        },
      ],
      true,
    );
  }
}
