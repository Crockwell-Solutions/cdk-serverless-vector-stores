import {
  DynamoDBClient,
  DescribeTableCommand,
  UpdateTableCommand,
  BatchWriteItemCommand,
  SearchVectorsCommand,
  type SearchVectorsCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { awsConfig } from '../config.js';
import {
  chunkSchema,
  type Filter,
  type LabConfig,
  type VectorRecord,
  type VectorStore,
  type SearchResponse,
} from '../types.js';
import { sleep, waitFor } from '../io.js';
export function dynamoSearchInput(
  config: LabConfig,
  vector: number[],
  topK: number,
  filter: Filter,
): SearchVectorsCommandInput {
  const fields = Object.entries(filter).filter(([, value]) => value !== undefined);
  return {
    TableName: config.tableName,
    IndexName: config.indexName,
    SearchVector: vector.map((v) => ({ N: String(v) })),
    TopK: topK,
    SearchConditionExpression: fields.map(([key]) => `#${key} = :${key}`).join(' AND '),
    ExpressionAttributeNames: Object.fromEntries(fields.map(([key]) => [`#${key}`, key])),
    ExpressionAttributeValues: marshall(Object.fromEntries(fields.map(([key, value]) => [`:${key}`, value]))),
    ProjectionExpression: 'id, #corpus, #p, #s, #m, #t, imageKey',
    ReturnConsumedCapacity: 'TOTAL',
  };
}
export class DynamoStore implements VectorStore {
  readonly name = 'dynamodb' as const;
  constructor(
    private config: LabConfig,
    private client = new DynamoDBClient(awsConfig(config)),
  ) {}
  async init() {
    const describe = async () =>
      (await this.client.send(new DescribeTableCommand({ TableName: this.config.tableName }))).Table;
    const existing = (await describe())?.VectorIndexes?.find((v) => v.IndexName === this.config.indexName);
    if (
      existing &&
      (existing.Dimensions !== this.config.dimensions ||
        existing.DistanceFunction !== 'COSINE' ||
        existing.VectorAttribute?.AttributeName !== 'vector')
    )
      throw new Error('DynamoDB index schema mismatch. Use a fresh lab.');
    if (!existing)
      await this.client.send(
        new UpdateTableCommand({
          TableName: this.config.tableName,
          AttributeDefinitions: [
            { AttributeName: 'corpus', AttributeType: 'S' },
            { AttributeName: 'modality', AttributeType: 'S' },
            { AttributeName: 'page', AttributeType: 'N' },
          ],
          VectorIndexUpdates: [
            {
              Create: {
                IndexName: this.config.indexName,
                VectorAttribute: { AttributeName: 'vector' },
                Dimensions: this.config.dimensions,
                DistanceFunction: 'COSINE',
                Projection: { ProjectionType: 'ALL' },
                SearchSchema: [
                  { AttributeName: 'corpus', SearchSchemaElementType: 'HASH' },
                  { AttributeName: 'modality', SearchSchemaElementType: 'INLINE_FILTER' },
                  { AttributeName: 'page', SearchSchemaElementType: 'INLINE_FILTER' },
                ],
              },
            },
          ],
        }),
      );
    await waitFor(
      'DynamoDB vector index ACTIVE',
      async () =>
        (await describe())?.VectorIndexes?.some(
          (v) => v.IndexName === this.config.indexName && v.IndexStatus === 'ACTIVE' && !v.Backfilling,
        ) ?? false,
    );
    // The separate search endpoint can lag the control-plane ACTIVE status.
    await waitFor(
      'DynamoDB search endpoint readiness',
      async () => {
        try {
          await this.search([1, ...Array<number>(this.config.dimensions - 1).fill(0)], 1, { corpus: '_readiness' });
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            error.name === 'ValidationException' &&
            /specified index|backfill/i.test(error.message)
          )
            return false;
          throw error;
        }
      },
      180_000,
    );
  }
  async upsert(records: VectorRecord[]) {
    for (let offset = 0; offset < records.length; offset += 25) {
      let pending = records.slice(offset, offset + 25).map(({ imagePath: _imagePath, ...record }) => ({
        PutRequest: { Item: marshall(record, { removeUndefinedValues: true }) },
      }));
      for (let attempt = 0; pending.length; attempt++) {
        if (attempt === 8) throw new Error(`DynamoDB still has ${pending.length} unprocessed writes; rerun ingest.`);
        const response = await this.client.send(
          new BatchWriteItemCommand({
            RequestItems: { [this.config.tableName]: pending },
            ReturnConsumedCapacity: 'TOTAL',
          }),
        );
        pending = (response.UnprocessedItems?.[this.config.tableName] ?? []) as typeof pending;
        if (pending.length) await sleep(Math.min(5000, 100 * 2 ** attempt) + Math.random() * 100);
      }
    }
  }
  async search(vector: number[], topK: number, filter: Filter): Promise<SearchResponse> {
    const input = dynamoSearchInput(this.config, vector, topK, filter);
    input.ExpressionAttributeNames = {
      ...input.ExpressionAttributeNames,
      '#p': 'page',
      '#s': 'source',
      '#m': 'modality',
      '#t': 'text',
    };
    const result = await this.client.send(new SearchVectorsCommand(input));
    return {
      hits: (result.SearchResults ?? []).map((hit) => ({
        ...chunkSchema.parse(unmarshall(hit.Item ?? {})),
        score: hit.Score ?? 0,
        scoreKind: 'distance',
      })),
      usage: result.ConsumedCapacity,
    };
  }
}
