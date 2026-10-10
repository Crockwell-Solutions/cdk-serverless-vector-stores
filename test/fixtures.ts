import type { LabConfig, VectorRecord } from '../src/types.js';
export const config: LabConfig = {
  region: 'eu-west-1',
  assetsBucket: 'lab-assets',
  tableName: 'documents',
  vectorIndexArn: 'arn:aws:s3vectors:eu-west-1:123456789012:bucket/lab/index/documents',
  collectionEndpoint: 'https://abcdef.aoss.eu-west-1.on.aws',
  collectionId: 'abcdef',
  collectionGroupName: 'vector-lab',
  indexName: 'documents',
  dimensions: 1024,
  embeddingModel: 'amazon.titan-embed-text-v2:0',
  chatModel: 'eu.amazon.nova-lite-v1:0',
};
export const record = (id: string, vector: number[], modality: 'text' | 'image' = 'text'): VectorRecord => ({
  id,
  vector,
  corpus: 'sample',
  source: 'aip.pdf',
  page: 1,
  modality,
  text: `Evidence ${id}`,
});
