import { z } from 'zod';

/**
 * Canonical adapter names accepted by the CLI and used as report keys.
 */
export const storeNames = ['opensearch', 's3', 'dynamodb'] as const;

export type StoreName = (typeof storeNames)[number];

/**
 * Validate deployment outputs and fix the embedding space shared by every store.
 */
export const configSchema = z.object({
  region: z.string().min(1),
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

/**
 * Source evidence with one-based physical PDF pages for citations and evaluation.
 * Image chunks contain generated descriptions; image paths/keys locate the original renders.
 */
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

/**
 * A source chunk paired with the shared embedding written to each backend.
 */
export type VectorRecord = Chunk & { vector: number[] };

/**
 * Common equality filters; corpus scoping keeps separate ingestion runs isolated.
 */
export type Filter = { corpus: string; modality?: 'text' | 'image'; page?: number };

/**
 * Preserve each backend's native score and direction instead of implying a shared scale.
 */
export type Hit = Chunk & { score: number; scoreKind: 'distance' | 'similarity' };

/**
 * Ranked evidence and any service-provided request usage, such as consumed capacity.
 */
export interface SearchResponse {
  hits: Hit[];
  usage?: unknown;
}

/**
 * Shared adapter contract used by ingestion, queries, and the benchmark runner.
 */
export interface VectorStore {
  name: StoreName;

  /**
   * Create or validate the index before corpus writes and retrieval experiments.
   */
  init(): Promise<void>;

  /**
   * Write records by stable ID; acknowledged writes may not yet be searchable.
   */
  upsert(records: VectorRecord[]): Promise<void>;

  /**
   * Retrieve the nearest eligible records after applying the common filters.
   */
  search(vector: number[], topK: number, filter: Filter): Promise<SearchResponse>;
}

/**
 * Manifest produced by local PDF preparation, including extraction settings and rendered pages.
 */
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

/**
 * Persist the model settings alongside embedded records so ingestion can reject incompatible data.
 */
export const embeddedSchema = z.object({
  schema: z.literal(1),
  corpus: corpusSchema,
  embeddingModel: z.string(),
  dimensions: z.number(),
  visionModel: z.string().nullable(),
  records: z.array(chunkSchema.extend({ vector: z.array(z.number()) })),
});

export type EmbeddedCorpus = z.infer<typeof embeddedSchema>;

/**
 * A retrieval prompt with optional modality filtering and manually labelled evidence pages.
 * Expected pages support retrieval scoring; they are not a complete answer-quality judgment.
 */
export const questionSchema = z.object({
  id: z.string(),
  question: z.string().min(1),
  modality: z.enum(['text', 'image']).optional(),
  expectedPages: z.array(z.number().int().positive()).optional(),
  notes: z.string().optional(),
});

export type Question = z.infer<typeof questionSchema>;
