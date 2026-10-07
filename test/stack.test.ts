import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { VectorLabStack } from '../lib/vector-lab-stack.js';
function synth() {
  const app = new App();
  return Template.fromStack(
    new VectorLabStack(app, 'TestLab', { env: { account: '123456789012', region: 'eu-west-1' } }),
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
    expect(json).toContain('OperatorArn');
    expect(json).toContain('s3vectors:QueryVectors');
    expect(json).toContain('dynamodb:SearchVectors');
    expect(json).not.toContain('AdministratorAccess');
  });
});
