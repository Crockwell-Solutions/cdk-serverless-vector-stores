import type { LabConfig, StoreName, VectorStore } from '../types.js';
import { OpenSearchStore } from './opensearch.js';
import { S3Store } from './s3.js';
import { DynamoStore } from './dynamodb.js';

/**
 * Select the backend adapter while keeping ingestion and benchmarking store-independent.
 */
export function createStore(name: StoreName, config: LabConfig): VectorStore {
  switch (name) {
    case 'opensearch':
      return new OpenSearchStore(config);
    case 's3':
      return new S3Store(config);
    case 'dynamodb':
      return new DynamoStore(config);
  }
}
