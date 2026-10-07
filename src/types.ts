import { z } from 'zod';
export const storeNames = ['opensearch', 's3', 'dynamodb'] as const;
export type StoreName = (typeof storeNames)[number];
export const configSchema = z.object({
  region: z.string().min(1),
  roleArn: z.string().startsWith('arn:'),
  assetsBucket: z.string().min(1),
  tableName: z.string().min(1),
  vectorIndexArn: z.string().startsWith('arn:'),
  collectionEndpoint: z.url(),
  collectionId: z.string().min(1),
  collectionGroupName: z.string().min(1),
  indexName: z.string().default('documents'),
  dimensions: z.literal(1024),
  embeddingModel: z.literal('amazon.titan-embed-text-v2:0'),
  chatModel: z.string().min(1),
});
export type LabConfig = z.infer<typeof configSchema>;
export const chunkSchema = z.object({
  id: z.string(),
  corpus: z.string(),
  source: z.string(),
  page: z.number().int().positive(),
  modality: z.enum(['text', 'image']),
  text: z.string().min(1),
  imagePath: z.string().optional(),
  imageKey: z.string().optional(),
});
export type Chunk = z.infer<typeof chunkSchema>;
export type VectorRecord = Chunk & { vector: number[] };
export type Filter = { corpus: string; modality?: 'text' | 'image'; page?: number };
export type Hit = Chunk & { score: number; scoreKind: 'distance' | 'similarity' };
export interface SearchResponse {
  hits: Hit[];
  usage?: unknown;
}
export interface VectorStore {
  name: StoreName;
  init(): Promise<void>;
  upsert(records: VectorRecord[]): Promise<void>;
  search(vector: number[], topK: number, filter: Filter): Promise<SearchResponse>;
}
export const corpusSchema = z.object({
  schema: z.literal(1),
  id: z.string(),
  pdf: z.string(),
  pdfSha256: z.string(),
  totalPages: z.number(),
  pages: z.array(z.number()),
  chunkChars: z.number(),
  overlap: z.number(),
  renderSize: z.number(),
  chunks: z.array(chunkSchema),
  images: z.array(z.object({ page: z.number(), path: z.string() })),
});
export type Corpus = z.infer<typeof corpusSchema>;
export const embeddedSchema = z.object({
  schema: z.literal(1),
  corpus: corpusSchema,
  embeddingModel: z.string(),
  dimensions: z.number(),
  visionModel: z.string().nullable(),
  records: z.array(chunkSchema.extend({ vector: z.array(z.number()) })),
});
export type EmbeddedCorpus = z.infer<typeof embeddedSchema>;
export const questionSchema = z.object({
  id: z.string(),
  question: z.string().min(1),
  modality: z.enum(['text', 'image']).optional(),
  expectedPages: z.array(z.number().int().positive()).optional(),
  notes: z.string().optional(),
});
export type Question = z.infer<typeof questionSchema>;
