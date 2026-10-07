import { CfnOutput, CfnParameter, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as aoss from 'aws-cdk-lib/aws-opensearchserverless';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as vectors from 'aws-cdk-lib/aws-s3vectors';

export class VectorLabStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const principal = new CfnParameter(this, 'OperatorArn', {
      type: 'String',
      description: 'IAM user or role ARN allowed to assume the lab role (not an STS session ARN)',
      allowedPattern: 'arn:aws:iam::[0-9]{12}:(user|role)/.+',
    });
    const name = new CfnParameter(this, 'LabName', {
      type: 'String',
      default: 'vector-lab',
      allowedPattern: '[a-z][a-z0-9-]{2,19}',
    }).valueAsString;
    const dimensions = 1024;
    const role = new iam.Role(this, 'OperatorRole', { assumedBy: new iam.ArnPrincipal(principal.valueAsString) });
    const assets = new s3.Bucket(this, 'Corpus', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const table = new dynamodb.Table(this, 'Documents', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const bucket = new vectors.CfnVectorBucket(this, 'Vectors', {});
    bucket.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const index = new vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: bucket.attrVectorBucketArn,
      indexName: 'documents',
      dataType: 'float32',
      dimension: dimensions,
      distanceMetric: 'cosine',
      metadataConfiguration: { nonFilterableMetadataKeys: ['text', 'source', 'imageKey'] },
    });
    index.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const group = new aoss.CfnCollectionGroup(this, 'CollectionGroup', {
      name,
      generation: 'NEXTGEN',
      standbyReplicas: 'ENABLED',
      capacityLimits: {
        minIndexingCapacityInOcu: 0,
        minSearchCapacityInOcu: 0,
        maxIndexingCapacityInOcu: 2,
        maxSearchCapacityInOcu: 2,
      },
    });
    group.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const encryption = new aoss.CfnSecurityPolicy(this, 'Encryption', {
      name,
      type: 'encryption',
      policy: Stack.of(this).toJsonString({
        Rules: [{ ResourceType: 'collection', Resource: [`collection/${name}`] }],
        AWSOwnedKey: true,
      }),
    });
    new aoss.CfnSecurityPolicy(this, 'Network', {
      name,
      type: 'network',
      policy: Stack.of(this).toJsonString([
        { Rules: [{ ResourceType: 'collection', Resource: [`collection/${name}`] }], AllowFromPublic: true },
      ]),
    });
    const collection = new aoss.CfnCollection(this, 'Collection', {
      name,
      type: 'VECTORSEARCH',
      collectionGroupName: group.name,
      standbyReplicas: 'ENABLED',
    });
    collection.addResourceDependency(group);
    collection.addResourceDependency(encryption);
    collection.applyRemovalPolicy(RemovalPolicy.DESTROY);
    new aoss.CfnAccessPolicy(this, 'DataAccess', {
      name,
      type: 'data',
      policy: Stack.of(this).toJsonString([
        {
          Principal: [role.roleArn],
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${name}`],
              Permission: ['aoss:DescribeCollectionItems'],
            },
            {
              ResourceType: 'index',
              Resource: [`index/${name}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
                'aoss:DeleteIndex',
                'aoss:UpdateIndex',
              ],
            },
          ],
        },
      ]),
    });
    assets.grantReadWrite(role);
    table.grantReadWriteData(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateTable', 'dynamodb:DescribeTable', 'dynamodb:SearchVectors'],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:GetIndex',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:QueryVectors',
          's3vectors:DeleteVectors',
          's3vectors:ListVectors',
        ],
        resources: [index.attrIndexArn],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ['aoss:APIAccessAll'], resources: [collection.attrArn] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['aoss:BatchGetCollection', 'aoss:BatchGetCollectionGroup'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:ListMetrics',
          'bedrock:ListFoundationModels',
          'bedrock:ListInferenceProfiles',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          `arn:${this.partition}:bedrock:eu-*::foundation-model/amazon.nova-lite-v1:0`,
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/eu.amazon.nova-lite-v1:0`,
        ],
      }),
    );
    new CfnOutput(this, 'LabConfig', {
      value: this.toJsonString({
        region: this.region,
        roleArn: role.roleArn,
        assetsBucket: assets.bucketName,
        tableName: table.tableName,
        vectorIndexArn: index.attrIndexArn,
        collectionEndpoint: collection.attrCollectionEndpoint,
        collectionId: collection.attrId,
        collectionGroupName: name,
        indexName: 'documents',
        dimensions,
        embeddingModel: 'amazon.titan-embed-text-v2:0',
        chatModel: 'eu.amazon.nova-lite-v1:0',
      }),
    });
    Tags.of(this).add('Project', 'serverless-vector-lab');
  }
}
