import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EmbeddedCorpus, StoreName, VectorStore } from '../src/types.js';
import { config, record } from './fixtures.js';
const fakes = vi.hoisted(() => ({ stores: new Map<string, unknown>(), embed: vi.fn() }));
vi.mock('../src/config.js', () => ({
  awsConfig: () => ({ credentials: async () => ({ accessKeyId: 'test-only', secretAccessKey: 'test-only' }) }),
}));
vi.mock('../src/stores/index.js', () => ({ createStore: (name: string) => fakes.stores.get(name) }));
vi.mock('../src/bedrock.js', () => ({
  Bedrock: class {
    embed = fakes.embed;
  },
}));
import { benchmark } from '../src/benchmark.js';
let output: string;
const vector = [1, ...Array<number>(1023).fill(0)];
const r = record('a', vector);
const data: EmbeddedCorpus = {
  schema: 1,
  corpus: {
    schema: 1,
    id: 'sample',
    pdf: 'example.pdf',
    pdfSha256: 'sample',
    totalPages: 1,
    pages: [1],
    chunkChars: 1800,
    overlap: 200,
    renderSize: 2000,
    chunks: [r],
    images: [],
  },
  embeddingModel: config.embeddingModel,
  dimensions: 1024,
  visionModel: null,
  records: [r],
};
beforeEach(async () => {
  output = await mkdtemp(path.join(tmpdir(), 'vector-lab-test-'));
  fakes.embed.mockReset().mockResolvedValue(vector);
  fakes.stores.clear();
});
afterEach(async () => {
  await rm(output, { recursive: true, force: true });
});
it('runs the benchmark end to end without AWS, preserves failures and writes machine-readable reports', async () => {
  const order: string[] = [];
  for (const name of ['s3', 'dynamodb'] as StoreName[]) {
    let calls = 0;
    const store: VectorStore = {
      name,
      init: vi.fn(),
      upsert: vi.fn(),
      search: async () => {
        order.push(name);
        calls++;
        if (name === 's3' && calls === 3) throw new Error('simulated throttle');
        return { hits: [{ ...r, score: 0, scoreKind: 'distance' }] };
      },
    };
    fakes.stores.set(name, store);
  }
  const report = await benchmark(
    data,
    config,
    ['s3', 'dynamodb'],
    [{ id: 'q', question: 'test', expectedPages: [1] }],
    { topK: 5, rounds: 2, warmup: 1, concurrency: 1, idleSeconds: 0, output },
  );
  expect(fakes.embed).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['s3', 's3', 'dynamodb', 'dynamodb', 's3', 'dynamodb', 'dynamodb', 's3']);
  expect(report.summary.s3!.errors).toBe(1);
  expect(report.summary.dynamodb!.meanRecallAtK).toBe(1);
  expect(report.summary.dynamodb!.pageHitRate).toBe(1);
  expect(report.samples).toHaveLength(8);
  expect((await readFile(path.join(output, 'samples.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(8);
  expect(
    JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8')).samples.some(
      (s: { error?: string }) => s.error,
    ),
  ).toBe(true);
  expect(await readFile(path.join(output, 'summary.csv'), 'utf8')).toContain('s3,2,1,');
  expect(await readFile(path.join(output, 'report.md'), 'utf8')).toContain('| s3 | 2 | 1 |');
});
it('rejects labels outside the corpus before embedding or querying', async () => {
  await expect(
    benchmark(data, config, ['s3'], [{ id: 'q', question: 'test', expectedPages: [2] }], {
      topK: 5,
      rounds: 1,
      warmup: 0,
      concurrency: 1,
      idleSeconds: 0,
      output,
    }),
  ).rejects.toThrow('outside this corpus');
  expect(fakes.embed).not.toHaveBeenCalled();
});
it('rejects image-only evaluation when no image descriptions were embedded', async () => {
  await expect(
    benchmark(data, config, ['s3'], [{ id: 'q', question: 'test', modality: 'image' }], {
      topK: 5,
      rounds: 1,
      warmup: 0,
      concurrency: 1,
      idleSeconds: 0,
      output,
    }),
  ).rejects.toThrow('needs image descriptions');
  expect(fakes.embed).not.toHaveBeenCalled();
});
