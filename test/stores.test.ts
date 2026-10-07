import { afterEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  SearchVectorsCommand,
  BatchWriteItemCommand,
  DescribeTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb';
import { S3VectorsClient, QueryVectorsCommand, PutVectorsCommand } from '@aws-sdk/client-s3vectors';
import { marshall } from '@aws-sdk/util-dynamodb';
import { DynamoStore } from '../src/stores/dynamodb.js';
import { S3Store } from '../src/stores/s3.js';
import { OpenSearchStore, openSearchQuery } from '../src/stores/opensearch.js';
import { config, record } from './fixtures.js';
const ddb = mockClient(DynamoDBClient),
  s3 = mockClient(S3VectorsClient);
afterEach(() => {
  ddb.reset();
  s3.reset();
});
describe('native vector APIs', () => {
  it('uses SearchVectors with numeric AttributeValues and inline equality filters', async () => {
    ddb.on(SearchVectorsCommand).resolves({
      SearchResults: [{ Item: marshall(record('a', [1, 0])), Score: 0.12 }],
      ConsumedCapacity: { VectorSearchRequestBytes: 40 },
    });
    const response = await new DynamoStore(config).search([1, 0], 5, { corpus: 'sample', modality: 'text', page: 1 });
    const input = ddb.commandCalls(SearchVectorsCommand)[0]!.args[0].input;
    expect(input.SearchVector).toEqual([{ N: '1' }, { N: '0' }]);
    expect(input.SearchConditionExpression).toBe('#corpus = :corpus AND #modality = :modality AND #page = :page');
    expect(input.ExpressionAttributeValues![':page']).toEqual({ N: '1' });
    expect(response.hits[0]!.scoreKind).toBe('distance');
    expect(response.usage).toEqual({ VectorSearchRequestBytes: 40 });
  });
  it('creates and waits for a real vector index, not a scan fallback', async () => {
    ddb
      .on(DescribeTableCommand)
      .resolvesOnce({ Table: { VectorIndexes: [] } })
      .resolves({ Table: { VectorIndexes: [{ IndexName: 'documents', IndexStatus: 'ACTIVE' }] } });
    ddb.on(UpdateTableCommand).resolves({});
    ddb.on(SearchVectorsCommand).resolves({ SearchResults: [] });
    await new DynamoStore(config).init();
    const index = ddb.commandCalls(UpdateTableCommand)[0]!.args[0].input.VectorIndexUpdates![0]!.Create!;
    expect(index.Dimensions).toBe(1024);
    expect(index.DistanceFunction).toBe('COSINE');
    expect(index.SearchSchema).toContainEqual({ AttributeName: 'corpus', SearchSchemaElementType: 'HASH' });
    expect(ddb.commandCalls(UpdateTableCommand)[0]!.args[0].input.AttributeDefinitions).toContainEqual({
      AttributeName: 'page',
      AttributeType: 'N',
    });
  });
  it('retries unprocessed DynamoDB writes without dropping records', async () => {
    const item = { PutRequest: { Item: marshall(record('a', [1, 0])) } };
    ddb
      .on(BatchWriteItemCommand)
      .resolvesOnce({ UnprocessedItems: { documents: [item] } })
      .resolves({});
    await new DynamoStore(config).upsert([record('a', [1, 0])]);
    expect(ddb.commandCalls(BatchWriteItemCommand)).toHaveLength(2);
    expect(ddb.commandCalls(BatchWriteItemCommand)[1]!.args[0].input.RequestItems!.documents).toEqual([item]);
  });
  it('batches DynamoDB writes below the API item limit', async () => {
    ddb.on(BatchWriteItemCommand).resolves({});
    await new DynamoStore(config).upsert(Array.from({ length: 26 }, (_, i) => record(String(i), [1, 0])));
    expect(ddb.commandCalls(BatchWriteItemCommand).map((r) => r.args[0].input.RequestItems!.documents!.length)).toEqual(
      [25, 1],
    );
  });
  it('returns S3 metadata in the same shape and uses the same filters', async () => {
    const { vector: _vector, ...chunk } = record('a', [1, 0]);
    s3.on(QueryVectorsCommand).resolves({ vectors: [{ key: 'a', metadata: chunk, distance: 0.1 }] });
    const result = await new S3Store(config).search([1, 0], 5, { corpus: 'sample', modality: 'image' });
    expect(result.hits[0]!.text).toBe('Evidence a');
    expect(s3.commandCalls(QueryVectorsCommand)[0]!.args[0].input.filter).toEqual({
      $and: [{ corpus: { $eq: 'sample' } }, { modality: { $eq: 'image' } }],
    });
    expect(s3.commandCalls(QueryVectorsCommand)[0]!.args[0].input.returnMetadata).toBe(true);
  });
  it('does not leak local image paths into remote metadata', async () => {
    s3.on(PutVectorsCommand).resolves({});
    await new S3Store(config).upsert([
      { ...record('a', [1, 0]), imagePath: '/private/local.jpg', imageKey: 'corpora/sample/1.jpg' },
    ]);
    const input = s3.commandCalls(PutVectorsCommand)[0]!.args[0].input;
    expect(JSON.stringify(input)).not.toContain('/private/local.jpg');
    expect(JSON.stringify(input)).toContain('corpora/sample/1.jpg');
  });
  it('rejects Classic OpenSearch and pushes filters into kNN', () => {
    expect(
      () => new OpenSearchStore({ ...config, collectionEndpoint: 'https://id.eu-west-1.aoss.amazonaws.com' }),
    ).toThrow('NextGen');
    const q = openSearchQuery([1, 0], 5, { corpus: 'sample', modality: 'image' });
    expect(q.query.knn.vector.filter.bool.filter).toEqual([
      { term: { corpus: 'sample' } },
      { term: { modality: 'image' } },
    ]);
  });
});
