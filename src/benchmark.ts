import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Bedrock } from './bedrock.js';
import { awsConfig } from './config.js';
import { createStore } from './stores/index.js';
import { sleep, writeJson } from './io.js';
import type { EmbeddedCorpus, Filter, Hit, LabConfig, Question, StoreName, VectorRecord } from './types.js';
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) throw new Error('Vector dimensions differ.');
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  if (!aa || !bb) throw new Error('Cannot compare zero vectors.');
  return dot / Math.sqrt(aa * bb);
}
export function exactSearch(records: VectorRecord[], vector: number[], topK: number, filter: Filter) {
  return records
    .filter(
      (r) =>
        r.corpus === filter.corpus &&
        (!filter.modality || r.modality === filter.modality) &&
        (!filter.page || r.page === filter.page),
    )
    .map((r) => ({ id: r.id, score: cosine(r.vector, vector) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, topK);
}
export function recallAtK(
  hits: Hit[],
  exact: { id: string; score: number }[],
  records: VectorRecord[],
  vector: number[],
  filter: Filter,
): number | null {
  if (!exact.length) return null;
  const cutoff = exact.at(-1)!.score;
  const byId = new Map(records.map((r) => [r.id, r]));
  const relevant = new Set(
    hits.slice(0, exact.length).flatMap((h) => {
      const r = byId.get(h.id);
      return r &&
        r.corpus === filter.corpus &&
        (!filter.modality || r.modality === filter.modality) &&
        (!filter.page || r.page === filter.page) &&
        cosine(r.vector, vector) >= cutoff - 1e-6
        ? [h.id]
        : [];
    }),
  );
  return relevant.size / exact.length;
}
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)]!;
}
export interface Sample {
  store: StoreName;
  question: string;
  phase: 'first' | 'warmup' | 'warm';
  round: number;
  ms: number;
  ids: string[];
  pages: number[];
  recall: number | null;
  pageHit: boolean | null;
  reciprocalRank: number | null;
  error?: string;
  usage?: unknown;
}
export function summarize(samples: Sample[]) {
  return Object.fromEntries(
    [...new Set(samples.map((s) => s.store))].map((store) => {
      const rows = samples.filter((s) => s.store === store && s.phase === 'warm');
      const ok = rows.filter((s) => !s.error);
      const mean = (items: number[]) => (items.length ? items.reduce((a, b) => a + b, 0) / items.length : null);
      return [
        store,
        {
          requests: rows.length,
          errors: rows.length - ok.length,
          p50Ms: percentile(
            ok.map((s) => s.ms),
            0.5,
          ),
          p95Ms: percentile(
            ok.map((s) => s.ms),
            0.95,
          ),
          p99Ms: percentile(
            ok.map((s) => s.ms),
            0.99,
          ),
          meanRecallAtK: mean(ok.flatMap((s) => (s.recall === null ? [] : [s.recall]))),
          pageHitRate: mean(ok.flatMap((s) => (s.pageHit === null ? [] : [Number(s.pageHit)]))),
          meanReciprocalRank: mean(ok.flatMap((s) => (s.reciprocalRank === null ? [] : [s.reciprocalRank]))),
          firstRequest: samples.find((s) => s.store === store && s.phase === 'first'),
        },
      ];
    }),
  );
}
async function pool<T>(items: T[], concurrency: number, fn: (value: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
}
export async function benchmark(
  data: EmbeddedCorpus,
  config: LabConfig,
  names: StoreName[],
  questions: Question[],
  options: { topK: number; rounds: number; warmup: number; concurrency: number; idleSeconds: number; output: string },
) {
  if (!questions.length) throw new Error('Question set is empty.');
  for (const q of questions) {
    if (q.expectedPages?.some((p) => !data.corpus.pages.includes(p)))
      throw new Error(
        `Question ${q.id} expects pages outside this corpus. Prepare the sample pages or use another question set.`,
      );
    if (q.modality === 'image' && !data.records.some((r) => r.modality === 'image'))
      throw new Error(`Question ${q.id} needs image descriptions. Run embed --vision.`);
  }
  const bedrock = new Bedrock(config);
  const vectors = await Promise.all(questions.map((q) => bedrock.embed(q.question)));
  const stores = names.map((name) => createStore(name, config));
  await awsConfig(config).credentials();
  if (options.idleSeconds) {
    console.error(
      `Waiting ${options.idleSeconds}s without store requests. Keep all other collection-group clients idle. This does not prove zero OCUs; use metrics.`,
    );
    for (let remaining = options.idleSeconds; remaining > 0; remaining -= 30) {
      await sleep(Math.min(30, remaining) * 1000);
      console.error(`Idle wait: ${Math.max(0, remaining - 30)}s remaining`);
    }
  }
  const startedAt = new Date().toISOString();
  await mkdir(options.output, { recursive: true });
  const rawFile = path.join(options.output, 'samples.jsonl');
  await writeFile(rawFile, '');
  const samples: Sample[] = [];
  const timings: Partial<Record<StoreName, number>> = {};
  const run = async (store: (typeof stores)[number], qi: number, phase: Sample['phase'], round: number) => {
    const q = questions[qi]!,
      vector = vectors[qi]!,
      filter: Filter = { corpus: data.corpus.id, modality: q.modality };
    const exact = exactSearch(data.records, vector, options.topK, filter);
    const start = performance.now();
    let sample: Sample;
    try {
      const response = await store.search(vector, options.topK, filter);
      const ms = performance.now() - start; // Excludes local exact search and scoring.
      const hitIndex = q.expectedPages ? response.hits.findIndex((h) => q.expectedPages!.includes(h.page)) : -1;
      sample = {
        store: store.name,
        question: q.id,
        phase,
        round,
        ms,
        ids: response.hits.map((h) => h.id),
        pages: response.hits.map((h) => h.page),
        recall: recallAtK(response.hits, exact, data.records, vector, filter),
        pageHit: q.expectedPages ? hitIndex >= 0 : null,
        reciprocalRank: q.expectedPages ? (hitIndex < 0 ? 0 : 1 / (hitIndex + 1)) : null,
        usage: response.usage,
      };
    } catch (error) {
      sample = {
        store: store.name,
        question: q.id,
        phase,
        round,
        ms: performance.now() - start,
        ids: [],
        pages: [],
        recall: null,
        pageHit: null,
        reciprocalRank: null,
        error: String(error),
      };
    }
    samples.push(sample);
    await appendFile(rawFile, JSON.stringify(sample) + '\n');
  };
  for (const store of stores) {
    await run(store, 0, 'first', 0);
    for (let i = 0; i < options.warmup; i++) await run(store, i % questions.length, 'warmup', i);
  }
  for (let round = 0; round < options.rounds; round++) {
    for (let n = 0; n < stores.length; n++) {
      const store = stores[(n + round) % stores.length]!;
      const start = performance.now();
      await pool(
        questions.map((_, i) => i),
        options.concurrency,
        (i) => run(store, i, 'warm', round),
      );
      timings[store.name] = (timings[store.name] ?? 0) + performance.now() - start;
    }
    console.error(`Benchmark round ${round + 1}/${options.rounds}`);
  }
  const summary = summarize(samples);
  const report = {
    schema: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    corpus: data.corpus.id,
    records: data.records.length,
    region: config.region,
    embeddingModel: data.embeddingModel,
    visionModel: data.visionModel,
    dimensions: data.dimensions,
    options,
    questions,
    methodology:
      'Client wall time includes network, serialization and up to 3 attempts. Embedding, exact baseline, answer generation excluded. First means first request in this run; zero OCU state is not assumed. Warm batch throughput includes local scoring/report overhead. Recall is tie-aware against exact cosine over the filtered corpus. Page labels measure retrieval only, not answer correctness.',
    summary,
    warmBatchElapsedMs: timings,
    samples,
  };
  await writeJson(path.join(options.output, 'report.json'), report);
  const csv = [
    'store,requests,errors,p50_ms,p95_ms,p99_ms,recall_at_k,page_hit_rate,mrr,warm_batch_requests_per_second',
    ...Object.entries(summary).map(([name, s]) =>
      [
        name,
        s.requests,
        s.errors,
        s.p50Ms,
        s.p95Ms,
        s.p99Ms,
        s.meanRecallAtK,
        s.pageHitRate,
        s.meanReciprocalRank,
        s.requests / ((timings[name as StoreName] ?? 1) / 1000),
      ].join(','),
    ),
  ].join('\n');
  await writeFile(path.join(options.output, 'summary.csv'), csv + '\n');
  const f = (n: number | null | undefined) => (n == null ? 'n/a' : n.toFixed(3));
  await writeFile(
    path.join(options.output, 'report.md'),
    `# Vector store benchmark\n\nCorpus: ${data.corpus.id}; ${data.records.length} vectors; ${config.region}.\n\n${report.methodology}\n\n| Store | Requests | Errors | p50 ms | p95 ms | p99 ms | Recall@k | Page hit rate |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${Object.entries(
      summary,
    )
      .map(
        ([name, s]) =>
          `| ${name} | ${s.requests} | ${s.errors} | ${f(s.p50Ms)} | ${f(s.p95Ms)} | ${f(s.p99Ms)} | ${f(s.meanRecallAtK)} | ${f(s.pageHitRate)} |`,
      )
      .join(
        '\n',
      )}\n\nFirst-request latency and failures are recorded separately in report.json. No cloud measurements are fabricated. A small corpus is a smoke test, not a large-scale service performance claim.\n`,
  );
  return report;
}
