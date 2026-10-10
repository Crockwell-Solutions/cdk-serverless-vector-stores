import { CfnOutput, CfnParameter, RemovalPolicy, Stack, Tags, Validations, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as aoss from 'aws-cdk-lib/aws-opensearchserverless';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as vectors from 'aws-cdk-lib/aws-s3vectors';

export interface VectorLabStackProps extends StackProps {
  /** IAM user or role discovered by the CDK app; omitted only for offline synthesis. */
  accessPrincipalArn?: string;
}

/**
 * Provision the three comparison stores, shared corpus assets, and a scoped runtime access policy.
 */
export class VectorLabStack extends Stack {
  /**
   * Build disposable demo resources and publish the configuration consumed by the local CLI.
   */
  constructor(scope: Construct, id: string, props?: VectorLabStackProps) {
    super(scope, id, props);

    // The CDK app resolves the caller; an unresolved parameter permits offline synthesis.
    const principal: string =
      props?.accessPrincipalArn ??
      new CfnParameter(this, 'AccessPrincipalArn', {
        type: 'String',
        description: 'IAM user or role ARN automatically resolved by the CDK app',
        allowedPattern: 'arn:aws:iam::[0-9]{12}:(user|role)/.+',
      }).valueAsString;
    const name = new CfnParameter(this, 'LabName', {
      type: 'String',
      default: 'vector-lab',
      allowedPattern: '[a-z][a-z0-9-]{2,19}',
    }).valueAsString;
    const dimensions = 1024;
    const indexName = 'documents';

    // Shared document/image assets are private; destroying the demo also removes these objects.
    const assets = new s3.Bucket(this, 'Corpus', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFormation creates both the on-demand table and its native vector index.
    const table = new dynamodb.Table(this, 'Documents', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // CDK's L2 Table has no vector-index API yet. Set the typed L1 properties on the same resource.
    const cfnTable = table.node.defaultChild as dynamodb.CfnTable;
    cfnTable.attributeDefinitions = [
      { attributeName: 'id', attributeType: 'S' },
      // SearchSchema fields must be declared alongside the table key, including inline filters.
      { attributeName: 'corpus', attributeType: 'S' },
      { attributeName: 'modality', attributeType: 'S' },
      { attributeName: 'page', attributeType: 'N' },
    ];
    cfnTable.vectorIndexes = [
      {
        indexName,
        dimensions,
        distanceFunction: 'COSINE',
        vectorAttribute: { attributeName: 'vector' },
        projection: { projectionType: 'ALL' },
        searchSchema: [
          { attributeName: 'corpus', searchSchemaElementType: 'HASH' },
          { attributeName: 'modality', searchSchemaElementType: 'INLINE_FILTER' },
          { attributeName: 'page', searchSchemaElementType: 'INLINE_FILTER' },
        ],
      },
    ];
    // CDK 2.272's validator checks table/GSI keys but omits vector SearchSchema when matching attributes.
    Validations.of(cfnTable).acknowledge({
      id: 'CloudFormation-Validate::E3039',
      reason:
        'corpus, modality and page are required AttributeDefinitions for VectorIndexes.SearchSchema; see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-dynamodb-table-vectorindex.html',
    });

    const bucket = new vectors.CfnVectorBucket(this, 'Vectors', {});
    bucket.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const index = new vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: bucket.attrVectorBucketArn,
      indexName,
      dataType: 'float32',
      dimension: dimensions,
      distanceMetric: 'cosine',
      // Keep large content and asset references as metadata without making them filter fields.
      metadataConfiguration: { nonFilterableMetadataKeys: ['text', 'source', 'imageKey'] },
    });
    index.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // NextGen permits zero minimum compute; caps bound the capacity available during the demo.
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

    // The local CLI uses the public endpoint; signed requests and data/IAM policies still govern access.
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

    // Explicit dependencies ensure the collection group and encryption policy exist before creation.
    collection.addResourceDependency(group);
    collection.addResourceDependency(encryption);
    collection.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // OpenSearch data permissions complement the collection-scoped IAM API permission below.
    new aoss.CfnAccessPolicy(this, 'DataAccess', {
      name,
      type: 'data',
      policy: Stack.of(this).toJsonString([
        {
          Principal: [principal],
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

    // Publish scoped runtime permissions as a policy an administrator can grant if needed.
    // It is deliberately unattached: deployment must not modify the caller's IAM or SSO configuration.
    const runtimeAccess = new iam.ManagedPolicy(this, 'RuntimeAccessPolicy', {
      description: 'Access to this vector lab for existing IAM identities or SSO permission sets',
      statements: [
        new iam.PolicyStatement({
          actions: [
            's3:GetObject*',
            's3:GetBucket*',
            's3:List*',
            's3:DeleteObject*',
            's3:PutObject',
            's3:PutObjectLegalHold',
            's3:PutObjectRetention',
            's3:PutObjectTagging',
            's3:PutObjectVersionTagging',
            's3:Abort*',
          ],
          resources: [assets.bucketArn, assets.arnForObjects('*')],
        }),
        new iam.PolicyStatement({
          actions: [
            'dynamodb:BatchGetItem',
            'dynamodb:Query',
            'dynamodb:GetItem',
            'dynamodb:Scan',
            'dynamodb:ConditionCheckItem',
            'dynamodb:BatchWriteItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:DescribeTable',
            'dynamodb:GetRecords',
            'dynamodb:GetShardIterator',
          ],
          resources: [table.tableArn],
        }),
      ],
    });

    runtimeAccess.addStatements(
      new iam.PolicyStatement({
        actions: ['dynamodb:DescribeTable', 'dynamodb:SearchVectors'],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );

    runtimeAccess.addStatements(
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

    runtimeAccess.addStatements(
      new iam.PolicyStatement({ actions: ['aoss:APIAccessAll'], resources: [collection.attrArn] }),
    );

    // Discovery and monitoring let CLI commands report service state and measured resource usage.
    runtimeAccess.addStatements(
      new iam.PolicyStatement({
        actions: ['aoss:BatchGetCollection', 'aoss:BatchGetCollectionGroup'],
        resources: ['*'],
      }),
    );

    runtimeAccess.addStatements(
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

    // Shared Bedrock calls create embeddings and image descriptions, and optionally generate answers.
    runtimeAccess.addStatements(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          `arn:${this.partition}:bedrock:eu-*::foundation-model/amazon.nova-lite-v1:0`,
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/eu.amazon.nova-lite-v1:0`,
        ],
      }),
    );

    // A single JSON output keeps the CLI aligned with generated resource names and model settings.
    new CfnOutput(this, 'LabConfig', {
      value: this.toJsonString({
        region: this.region,
        assetsBucket: assets.bucketName,
        tableName: table.tableName,
        vectorIndexArn: index.attrIndexArn,
        collectionEndpoint: collection.attrCollectionEndpoint,
        collectionId: collection.attrId,
        collectionGroupName: name,
        indexName,
        dimensions,
        embeddingModel: 'amazon.titan-embed-text-v2:0',
        chatModel: 'eu.amazon.nova-lite-v1:0',
      }),
    });

    new CfnOutput(this, 'RuntimePolicyArn', {
      value: runtimeAccess.managedPolicyArn,
      description: 'Optional scoped permissions for the current identity; not automatically attached',
    });

    Tags.of(this).add('Project', 'serverless-vector-lab');
  }
}
