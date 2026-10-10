import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { awsConfig } from '../config.js';
import { sleep } from '../io.js';
import {
  chunkSchema,
  type Filter,
  type LabConfig,
  type SearchResponse,
  type VectorRecord,
  type VectorStore,
} from '../types.js';

/**
 * Build a filtered k-nearest-neighbor query while excluding vectors from the returned chunk metadata.
 */
export function openSearchQuery(vector: number[], topK: number, filter: Filter) {
  return {
    size: topK,
    _source: { excludes: ['vector'] },
    query: {
      knn: {
        vector: {
          vector,
          k: topK,
          filter: {
            bool: {
              filter: Object.entries(filter)
                .filter(([, v]) => v !== undefined)
                .map(([key, value]) => ({ term: { [key]: value } })),
            },
          },
        },
      },
    },
  };
}

/**
 * Access the NextGen OpenSearch Serverless collection through signed HTTP requests.
 */
export class OpenSearchStore implements VectorStore {
  readonly name = 'opensearch' as const;
  private signer: SignatureV4;

  /**
   * Configure request signing and reject endpoints outside the lab's supported NextGen format.
   */
  constructor(private config: LabConfig) {
    this.signer = new SignatureV4({
      credentials: awsConfig(config).credentials,
      region: config.region,
      service: 'aoss',
      sha256: Sha256,
    });

    const url = new URL(config.collectionEndpoint);

    if (url.protocol !== 'https:' || !url.hostname.endsWith(`.aoss.${config.region}.on.aws`)) {
      throw new Error('Expected a NextGen per-collection on.aws endpoint; Classic is deliberately unsupported.');
    }
  }

  /**
   * Sign and send a JSON or bulk NDJSON request, retrying selected throttling and availability responses.
   */
  async request<T>(method: string, suffix: string, body?: unknown, ndjson = false, attempts = 3): Promise<T> {
    const url = new URL(`${this.config.collectionEndpoint.replace(/\/$/, '')}/${suffix}`);
    const payload = body === undefined ? undefined : ndjson ? String(body) : JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      // Sign each attempt independently and hash the exact bytes sent as the request body.
      const signed = await this.signer.sign(
        new HttpRequest({
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            host: url.hostname,
            'content-type': ndjson ? 'application/x-ndjson' : 'application/json',
            'x-amz-content-sha256': await sha256(payload ?? ''),
          },
          body: payload,
        }),
      );
      const response = await fetch(url, {
        method,
        headers: signed.headers,
        body: payload,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();

      if (!response.ok) {
        if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
          await sleep(500 * 2 ** attempt);
          continue;
        }

        const error = new Error(`OpenSearch ${response.status}: ${text.slice(0, 1500)}`);
        Object.assign(error, { status: response.status });
        throw error;
      }

      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  /**
   * Validate an existing vector mapping or create the lab index when the mapping endpoint returns 404.
   */
  async init() {
    const index = encodeURIComponent(this.config.indexName);

    try {
      const mapping = await this.request<
        Record<string, { mappings: { properties: { vector: { dimension: number; space_type: string } } } }>
      >('GET', `${index}/_mapping`);
      const vector = mapping[this.config.indexName]?.mappings.properties.vector;

      if (vector?.dimension !== this.config.dimensions || vector.space_type !== 'cosinesimil') {
        throw new Error('OpenSearch index schema mismatch.');
      }

      return;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        throw error;
      }
    }

    await this.request('PUT', index, {
      settings: { 'index.knn': true, 'index.knn.remote_index_build.enabled': false },
      mappings: {
        properties: {
          vector: {
            type: 'knn_vector',
            dimension: this.config.dimensions,
            space_type: 'cosinesimil',
            compression_level: '1x',
          },
          id: { type: 'keyword' },
          corpus: { type: 'keyword' },
          page: { type: 'integer' },
          modality: { type: 'keyword' },
          text: { type: 'text' },
          source: { type: 'keyword' },
          imageKey: { type: 'keyword' },
        },
      },
    });
  }

  /**
   * Bulk-index bounded batches with deterministic IDs, surfacing item failures even when HTTP succeeds.
   */
  async upsert(records: VectorRecord[]) {
    for (let offset = 0; offset < records.length; offset += 100) {
      // Bulk requests alternate action and document lines and require a final newline.
      const body =
        records
          .slice(offset, offset + 100)
          .flatMap(({ imagePath: _imagePath, ...record }) => [
            JSON.stringify({ index: { _index: this.config.indexName, _id: record.id } }),
            JSON.stringify(record),
          ])
          .join('\n') + '\n';
      const result = await this.request<{ errors: boolean; items: unknown[] }>('POST', '_bulk', body, true);

      if (result.errors) {
        throw new Error(
          `OpenSearch bulk write failed: ${JSON.stringify(result.items).slice(0, 2000)}. Rerun ingest; IDs are deterministic.`,
        );
      }
    }
  }

  /**
   * Return complete search results with OpenSearch similarity scores; higher scores are closer.
   */
  async search(vector: number[], topK: number, filter: Filter): Promise<SearchResponse> {
    const result = await this.request<{
      timed_out?: boolean;
      _shards?: { failed: number };
      hits: { hits: { _source: unknown; _id: string; _score: number }[] };
    }>('POST', `${encodeURIComponent(this.config.indexName)}/_search`, openSearchQuery(vector, topK, filter));

    if (result.timed_out || result._shards?.failed) {
      throw new Error('OpenSearch returned a partial search response.');
    }

    return {
      hits: result.hits.hits.map((hit) => ({
        ...chunkSchema.parse(hit._source),
        id: hit._id,
        score: hit._score,
        scoreKind: 'similarity',
      })),
    };
  }
}

/**
 * Encode the request payload's SHA-256 digest as the hexadecimal string used by SigV4.
 */
async function sha256(text: string) {
  const hash = new Sha256();
  hash.update(text);

  return Buffer.from(await hash.digest()).toString('hex');
}
