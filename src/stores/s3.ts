import { S3VectorsClient, GetIndexCommand, PutVectorsCommand, QueryVectorsCommand } from '@aws-sdk/client-s3vectors';
import { awsConfig } from '../config.js';
import {
  chunkSchema,
  type Filter,
  type LabConfig,
  type VectorRecord,
  type VectorStore,
  type SearchResponse,
} from '../types.js';

/**
 * Translate the required corpus filter and optional page/modality filters into S3 equality clauses.
 */
export function s3Filter(filter: Filter) {
  const clauses = Object.entries(filter)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ [key]: { $eq: v } }));

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/**
 * Store embeddings and chunk metadata in the S3 Vectors index created by CDK.
 */
export class S3Store implements VectorStore {
  readonly name = 's3' as const;

  /**
   * Use the configured lab credentials, or an injected SDK client for tests.
   */
  constructor(
    private config: LabConfig,
    private client = new S3VectorsClient(awsConfig(config)),
  ) {}

  /**
   * Check that the deployed index matches the shared embedding dimensions and distance metric.
   */
  async init() {
    const { index } = await this.client.send(new GetIndexCommand({ indexArn: this.config.vectorIndexArn }));

    if (index?.dimension !== this.config.dimensions || index.distanceMetric !== 'cosine') {
      throw new Error('S3 vector index schema mismatch.');
    }
  }

  /**
   * Write bounded batches using stable chunk IDs so ingestion can be rerun safely.
   */
  async upsert(records: VectorRecord[]) {
    for (let offset = 0; offset < records.length; offset += 100) {
      await this.client.send(
        new PutVectorsCommand({
          indexArn: this.config.vectorIndexArn,
          vectors: records.slice(offset, offset + 100).map(({ vector, imagePath: _imagePath, ...chunk }) => ({
            key: chunk.id,
            data: { float32: vector },
            // Local image paths stay local; serialization also removes undefined metadata fields.
            metadata: JSON.parse(JSON.stringify(chunk)),
          })),
        }),
      );
    }
  }

  /**
   * Retrieve matching chunks with the backend's cosine distance; smaller scores are closer.
   */
  async search(vector: number[], topK: number, filter: Filter): Promise<SearchResponse> {
    const result = await this.client.send(
      new QueryVectorsCommand({
        indexArn: this.config.vectorIndexArn,
        queryVector: { float32: vector },
        topK,
        filter: s3Filter(filter),
        returnMetadata: true,
        returnDistance: true,
      }),
    );

    return {
      hits: (result.vectors ?? []).map((hit) => ({
        ...chunkSchema.parse({ ...(hit.metadata as Record<string, unknown>), id: hit.key }),
        score: hit.distance ?? 0,
        scoreKind: 'distance',
      })),
    };
  }
}
