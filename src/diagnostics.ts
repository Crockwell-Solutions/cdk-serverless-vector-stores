import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import {
  OpenSearchServerlessClient,
  BatchGetCollectionGroupCommand,
  BatchGetCollectionCommand,
} from '@aws-sdk/client-opensearchserverless';
import { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand, type Metric } from '@aws-sdk/client-cloudwatch';
import { awsConfig } from './config.js';
import type { LabConfig } from './types.js';

/**
 * Checks identity, scale-to-zero settings, and model listings without querying a vector index.
 */
export async function doctor(config: LabConfig) {
  const options = awsConfig(config);
  const identity = await new STSClient(options).send(new GetCallerIdentityCommand({}));
  const aoss = new OpenSearchServerlessClient(options);
  const groupResponse = await aoss.send(new BatchGetCollectionGroupCommand({ names: [config.collectionGroupName] }));
  const group = groupResponse.collectionGroupDetails?.[0];

  // Both capacity floors must be zero; NEXTGEN alone does not establish the idle configuration.
  if (
    !group ||
    group.generation !== 'NEXTGEN' ||
    group.capacityLimits?.minIndexingCapacityInOCU !== 0 ||
    group.capacityLimits?.minSearchCapacityInOCU !== 0
  ) {
    throw new Error(`Scale-to-zero configuration not verified: ${JSON.stringify(groupResponse)}`);
  }

  const collection = await aoss.send(new BatchGetCollectionCommand({ ids: [config.collectionId] }));
  const bedrock = new BedrockClient(options);
  const models = await bedrock.send(new ListFoundationModelsCommand({}));
  const profiles = await bedrock.send(new ListInferenceProfilesCommand({}));

  // Being listed is only discovery evidence, not proof that this caller can invoke the model.
  return {
    identity: { account: identity.Account, arn: identity.Arn },
    group,
    collection: collection.collectionDetails,
    embeddingModelListed: models.modelSummaries?.some((m) => m.modelId === config.embeddingModel),
    chatProfileListed: profiles.inferenceProfileSummaries?.some((m) => m.inferenceProfileId === config.chatModel),
    note: 'Control-plane checks only. Model listing does not prove invocation permissions or account enablement. Run embed and query to verify runtime access. No store data-plane calls were made.',
  };
}

/**
 * Reads recent collection-group OCU samples from CloudWatch without waking the collection.
 */
export async function metrics(config: LabConfig, minutes: number) {
  const client = new CloudWatchClient(awsConfig(config));
  const found: Metric[] = [];

  // Discover the published dimension sets instead of assuming the group's name is the only dimension.
  for (const metricName of ['IndexingOCU', 'SearchOCU']) {
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new ListMetricsCommand({
          Namespace: 'AWS/AOSS',
          MetricName: metricName,
          Dimensions: [{ Name: 'CollectionGroupName', Value: config.collectionGroupName }],
          NextToken: nextToken,
        }),
      );
      found.push(...(response.Metrics ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
  }

  // An absent series is unknown usage, not evidence of zero capacity.
  if (!found.length) {
    return { note: 'No recent group metrics found. Missing data does not mean zero OCUs.', series: [] };
  }

  const end = new Date(),
    start = new Date(end.getTime() - minutes * 60_000);

  // Keep timestamped one-minute sums and CloudWatch's status metadata for interpreting delayed data.
  const response = await client.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: found.map((metric, i) => ({
        Id: `m${i}`,
        Label: metric.MetricName,
        MetricStat: { Metric: metric, Period: 60, Stat: 'Sum' },
        ReturnData: true,
      })),
    }),
  );

  return {
    start,
    end,
    note: 'CloudWatch control-plane read does not wake the collection. Missing or delayed samples are not zero.',
    series: response.MetricDataResults,
  };
}
