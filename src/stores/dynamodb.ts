import {
  DynamoDBClient,
  DescribeTableCommand,
  BatchWriteItemCommand,
  SearchVectorsCommand,
  type SearchVectorsCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { awsConfig } from '../config.js';
import { assertDynamoIndex } from '../dynamodb-index.js';
import {
  chunkSchema,
  type Filter,
  type LabConfig,
  type VectorRecord,
  type VectorStore,
  type SearchResponse,
} from '../types.js';
import { sleep, waitFor } from '../io.js';

/**
 * Build the native vector query, aliasing filter fields and requesting chunk metadata plus capacity usage.
 */
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

/**
 * Keep chunk metadata and embeddings together in a DynamoDB table with a native vector index.
 */
export class DynamoStore implements VectorStore {
  readonly name = 'dynamodb' as const;

  /**
   * Use the configured lab credentials, or an injected SDK client for tests.
   */
  constructor(
    private config: LabConfig,
    private client = new DynamoDBClient(awsConfig(config)),
  ) {}

  /**
   * Validate the vector index managed by CloudFormation and wait for searchable readiness.
   */
  async init() {
    /**
     * Validate fresh control-plane state before accepting the deployed index as ready.
     */
    const indexReady = async () => {
      const table = (await this.client.send(new DescribeTableCommand({ TableName: this.config.tableName }))).Table;
      const index = assertDynamoIndex(table, this.config.indexName, this.config.dimensions);

      return index.IndexStatus === 'ACTIVE' && !index.Backfilling;
    };

    await waitFor('DynamoDB vector index ACTIVE', indexReady);

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
          ) {
            return false;
          }

          throw error;
        }
      },
      180_000,
    );
  }

  /**
   * Upsert stable chunk IDs in batches of 25, retrying only writes DynamoDB leaves unprocessed.
   */
  async upsert(records: VectorRecord[]) {
    for (let offset = 0; offset < records.length; offset += 25) {
      let pending = records.slice(offset, offset + 25).map(({ imagePath: _imagePath, ...record }) => ({
        PutRequest: { Item: marshall(record, { removeUndefinedValues: true }) },
      }));

      for (let attempt = 0; pending.length; attempt++) {
        if (attempt === 8) {
          throw new Error(`DynamoDB still has ${pending.length} unprocessed writes; rerun ingest.`);
        }

        const response = await this.client.send(
          new BatchWriteItemCommand({
            RequestItems: { [this.config.tableName]: pending },
            ReturnConsumedCapacity: 'TOTAL',
          }),
        );
        pending = (response.UnprocessedItems?.[this.config.tableName] ?? []) as typeof pending;

        if (pending.length) {
          // Capped exponential backoff with jitter avoids retrying throttled writes in lockstep.
          await sleep(Math.min(5000, 100 * 2 ** attempt) + Math.random() * 100);
        }
      }
    }
  }

  /**
   * Return projected chunks and consumed capacity, preserving the backend's distance scores.
   */
  async search(vector: number[], topK: number, filter: Filter): Promise<SearchResponse> {
    const input = dynamoSearchInput(this.config, vector, topK, filter);

    // These aliases support the projection regardless of which optional filters are present.
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
