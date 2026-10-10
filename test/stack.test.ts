import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { VectorLabStack } from '../lib/vector-lab-stack.js';
import { dynamoVectorIndexDefinition } from '../src/dynamodb-index.js';
function synth(accessPrincipalArn?: string) {
  const app = new App();
  return Template.fromStack(
    new VectorLabStack(app, 'TestLab', {
      env: { account: '123456789012', region: 'eu-west-1' },
      accessPrincipalArn,
    }),
  );
}
describe('idle-cost and security invariants', () => {
  it('provisions NEXTGEN with explicit zero floors and low capacity caps', () => {
    const t = synth();
    t.hasResourceProperties('AWS::OpenSearchServerless::CollectionGroup', {
      Generation: 'NEXTGEN',
      CapacityLimits: {
        MinIndexingCapacityInOcu: 0,
        MinSearchCapacityInOcu: 0,
        MaxIndexingCapacityInOcu: 2,
        MaxSearchCapacityInOcu: 2,
      },
    });
    t.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
      Type: 'VECTORSEARCH',
      CollectionGroupName: Match.anyValue(),
    });
    t.hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    t.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: { NonFilterableMetadataKeys: ['text', 'source', 'imageKey'] },
    });
    t.resourceCountIs('AWS::S3Vectors::Index', 1);
    for (const type of [
      'AWS::EC2::NatGateway',
      'AWS::EC2::VPC',
      'AWS::CodePipeline::Pipeline',
      'AWS::CloudFront::Distribution',
      'AWS::ApiGateway::RestApi',
      'AWS::KMS::Key',
      'AWS::Bedrock::KnowledgeBase',
      'AWS::Bedrock::DataSource',
    ])
      t.resourceCountIs(type, 0);
  });
  it('protects source assets and makes demo data destroyable', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    t.hasResource('AWS::S3Vectors::Index', { DeletionPolicy: 'Delete' });
    const json = JSON.stringify(t.toJSON());
    expect(json).not.toContain('OperatorArn');
    expect(json).not.toContain('OperatorRole');
    expect(json).toContain('s3vectors:QueryVectors');
    expect(json).toContain('dynamodb:SearchVectors');
    expect(json).not.toContain('AdministratorAccess');
  });

  it('creates the DynamoDB table and native vector index with the required filter types', () => {
    const t = synth();
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'corpus', AttributeType: 'S' },
        { AttributeName: 'modality', AttributeType: 'S' },
        { AttributeName: 'page', AttributeType: 'N' },
      ],
      VectorIndexes: [
        {
          IndexName: 'documents',
          Dimensions: 1024,
          DistanceFunction: 'COSINE',
          VectorAttribute: { AttributeName: 'vector' },
          Projection: { ProjectionType: 'ALL' },
          SearchSchema: [
            { AttributeName: 'corpus', SearchSchemaElementType: 'HASH' },
            { AttributeName: 'modality', SearchSchemaElementType: 'INLINE_FILTER' },
            { AttributeName: 'page', SearchSchemaElementType: 'INLINE_FILTER' },
          ],
        },
      ],
    });
    // Runtime validation must match the index that CDK deploys.
    expect(t.toJSON().Resources.Documents7E5B2978.Properties.VectorIndexes).toEqual([
      dynamoVectorIndexDefinition('documents', 1024),
    ]);
  });

  it('keeps synthesis offline and points OpenSearch data access at the principal parameter', () => {
    const t = synth();
    t.hasParameter('AccessPrincipalArn', { Type: 'String' });
    const policy = Object.values(t.findResources('AWS::OpenSearchServerless::AccessPolicy'))[0]!.Properties.Policy;

    expect(JSON.stringify(policy)).toContain('"Ref":"AccessPrincipalArn"');
    expect(JSON.stringify(policy)).not.toContain('OperatorRole');
    expect(JSON.stringify(t.toJSON().Outputs.LabConfig)).not.toContain('roleArn');
  });

  it('uses the app-resolved principal directly during deployment and diff', () => {
    const principal = 'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/eu-west-1/Demo';
    const t = synth(principal);
    const policy = Object.values(t.findResources('AWS::OpenSearchServerless::AccessPolicy'))[0]!.Properties.Policy;

    expect(JSON.stringify(policy)).toContain(principal);
    expect(t.toJSON().Parameters).not.toHaveProperty('AccessPrincipalArn');
  });

  it('publishes scoped runtime permissions without attaching policies to existing identities', () => {
    const t = synth();
    const policies = t.findResources('AWS::IAM::ManagedPolicy');
    expect(Object.keys(policies)).toHaveLength(1);
    const [policyId, resource] = Object.entries(policies)[0]!;
    const properties = resource.Properties;

    expect(policyId).toMatch(/^RuntimeAccessPolicy/);
    for (const attachment of ['Roles', 'Users', 'Groups']) {
      expect(properties).not.toHaveProperty(attachment);
    }
    t.hasOutput('RuntimePolicyArn', { Value: { Ref: policyId } });

    const statements = properties.PolicyDocument.Statement;
    for (const action of [
      's3:PutObject',
      'dynamodb:SearchVectors',
      's3vectors:QueryVectors',
      'aoss:APIAccessAll',
      'bedrock:InvokeModel',
    ]) {
      const granting = statements.filter((statement: { Action: string | string[] }) =>
        [statement.Action].flat().includes(action),
      );
      expect(granting).toHaveLength(1);
      expect([granting[0].Resource].flat()).not.toContain('*');
    }
    expect(JSON.stringify(properties)).not.toContain('sts:AssumeRole');
    expect(JSON.stringify(properties)).not.toContain('dynamodb:UpdateTable');
  });
});
