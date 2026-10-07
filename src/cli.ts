#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { readJson, writeJson, workDir, fileHash, waitFor } from './io.js';
import { corpusSchema, questionSchema, storeNames, type StoreName } from './types.js';
import { inspectPdf, extractText, prepare } from './pdf.js';
import { embedCorpus, ingest, loadEmbedded } from './ingest.js';
import { createStore } from './stores/index.js';
import { Bedrock } from './bedrock.js';
import { benchmark, cosine } from './benchmark.js';
import { doctor, metrics } from './diagnostics.js';
function integer(min: number, max: number) {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
    return n;
  };
}
function stores(value: string): StoreName[] {
  const names = value === 'all' ? [...storeNames] : value.split(',');
  if (!names.length || names.some((v) => !storeNames.includes(v as StoreName)) || new Set(names).size !== names.length)
    throw new InvalidArgumentError('Use all or comma-separated opensearch,s3,dynamodb.');
  return names as StoreName[];
}
function modality(value: string): 'text' | 'image' {
  if (value !== 'text' && value !== 'image') throw new InvalidArgumentError('Use text or image.');
  return value;
}
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const app = new Command()
  .name('vector-lab')
  .description('Vector-store comparison: OpenSearch NextGen / S3 Vectors / DynamoDB')
  .option('--config <file>', 'CDK outputs or direct LabConfig JSON', '.vector-lab/outputs.json');
const config = () => loadConfig(app.opts<{ config: string }>().config);
app
  .command('inspect')
  .description('Inspect PDF locally; optionally find physical page numbers')
  .option('--pdf <file>', 'PDF input', 'data/uk-aip-heathrow-demo.pdf')
  .option('--find <text>', 'Case-insensitive literal text to find')
  .action(async (o) => {
    const info = await inspectPdf(o.pdf);
    console.log(info.info);
    if (o.find) {
      const pages = await extractText(o.pdf, await fileHash(o.pdf));
      print(
        pages.flatMap((text, i) => {
          const found = text.toLowerCase().indexOf(o.find.toLowerCase());
          return found >= 0
            ? [{ page: i + 1, excerpt: text.slice(Math.max(0, found - 100), found + 300).replace(/\s+/g, ' ') }]
            : [];
        }),
      );
    }
  });
app
  .command('prepare')
  .description('Extract the complete PDF locally, preserving physical demo PDF page numbers')
  .option('--pdf <file>', 'PDF input', 'data/uk-aip-heathrow-demo.pdf')
  .option('--images', 'Render every page for vision descriptions and multimodal answers', false)
  .option('--chunk-chars <number>', 'Maximum characters per chunk', integer(100, 4000), 1800)
  .option('--overlap <number>', 'Character overlap', integer(0, 3999), 200)
  .option('--output <file>', 'Corpus manifest', '.vector-lab/corpus.json')
  .action(async (o) => {
    const result = await prepare(o.pdf, o.images, o.chunkChars, o.overlap);
    await writeJson(o.output, result);
    print({
      corpus: result.id,
      pages: result.pages,
      textChunks: result.chunks.length,
      images: result.images.length,
      output: path.resolve(o.output),
      awsCalls: 0,
    });
  });
app
  .command('plan')
  .description('Show local work/volume estimate before paid Bedrock calls')
  .option('--corpus <file>', 'Prepared corpus', '.vector-lab/corpus.json')
  .action(async (o) => {
    const data = corpusSchema.parse(await readJson(o.corpus));
    print({
      pages: data.pages.length,
      textChunks: data.chunks.length,
      characters: data.chunks.reduce((s, c) => s + c.text.length, 0),
      approximateTextTokens: Math.ceil(data.chunks.reduce((s, c) => s + c.text.length, 0) / 4),
      visionCallsIfEnabled: data.images.length,
      vectorBytesPerStoreTextOnly: data.chunks.length * 1024 * 4,
      note: 'Tokens are a rough characters/4 estimate. Image token counts, captions, metadata, index overhead, request charges and storage are additional. Embeddings and captions are cached; see docs/costs.md.',
    });
  });
app
  .command('doctor')
  .description('Check assumed role, NextGen configuration and model listings without waking the data plane')
  .action(async () => print(await doctor(await config())));
app
  .command('init')
  .description('Create OpenSearch and DynamoDB indexes idempotently; validate S3 index')
  .option('--stores <names>', 'Stores to initialize', stores, [...storeNames])
  .action(async (o) => {
    const c = await config();
    for (const name of o.stores) {
      await createStore(name, c).init();
      console.log(`${name}: ready`);
    }
  });
app
  .command('embed')
  .description('Generate cached Bedrock embeddings and optional vision descriptions (paid API calls)')
  .option('--corpus <file>', 'Prepared corpus', '.vector-lab/corpus.json')
  .option('--vision', 'Describe rendered pages with Bedrock', false)
  .option(
    '--max-chunks <number>',
    'Maximum text chunks before embedding; explicit cap for larger runs',
    integer(1, 1000000),
    300,
  )
  .option('--max-image-pages <number>', 'Maximum pages sent to the vision model', integer(1, 100000), 20)
  .option('--output <file>', 'Embedded dataset', '.vector-lab/embedded.json')
  .action(async (o) => {
    const data = corpusSchema.parse(await readJson(o.corpus));
    if (data.chunks.length > o.maxChunks || (o.vision && data.images.length > o.maxImagePages))
      throw new Error(
        'Corpus exceeds the configured call limits. Explicitly increase --max-chunks / --max-image-pages after reviewing plan.',
      );
    const result = await embedCorpus(data, await config(), o.vision);
    await writeJson(o.output, result);
    print({ corpus: result.corpus.id, records: result.records.length, output: path.resolve(o.output) });
  });
app
  .command('ingest')
  .description('Upload the identical embedded corpus to all selected stores; resume from checkpoints')
  .option('--input <file>', 'Embedded dataset', '.vector-lab/embedded.json')
  .option('--stores <names>', 'Stores', stores, [...storeNames])
  .option('--force', 'Rewrite records even if local checkpoint marks them complete', false)
  .action(async (o) => {
    const c = await config();
    await ingest(await loadEmbedded(o.input, c), c, o.stores, o.force);
    console.log('Writes complete. Run verify before benchmarking; search visibility may lag writes.');
  });
app
  .command('verify')
  .description('Wait for representative records to become searchable (wakes OpenSearch)')
  .option('--input <file>', 'Embedded dataset', '.vector-lab/embedded.json')
  .option('--stores <names>', 'Stores', stores, [...storeNames])
  .option('--probes <number>', 'Evenly spaced probes; use record count for complete probing', integer(1, 1000000), 10)
  .action(async (o) => {
    const c = await config(),
      data = await loadEmbedded(o.input, c),
      count = Math.min(o.probes, data.records.length);
    const probes = Array.from(
      { length: count },
      (_, i) => data.records[Math.floor((i * (data.records.length - 1)) / Math.max(1, count - 1))]!,
    );
    for (const name of o.stores) {
      const store = createStore(name, c);
      for (const record of probes)
        await waitFor(
          `${name} page ${record.page} visibility`,
          async () => {
            const result = await store.search(record.vector, 10, {
              corpus: data.corpus.id,
              page: record.page,
              modality: record.modality,
            });
            return result.hits.some((h) => {
              const candidate = data.records.find((r) => r.id === h.id);
              return candidate && cosine(record.vector, candidate.vector) > 1 - 1e-6;
            });
          },
          180000,
        );
      console.log(`${name}: ${count} probes visible; ${data.records.length} records in the source manifest.`);
    }
  });
app
  .command('query')
  .description('Retrieve evidence and optionally generate a cited Bedrock answer')
  .requiredOption('--question <text>', 'Natural-language question')
  .option('--input <file>', 'Embedded dataset', '.vector-lab/embedded.json')
  .option('--stores <names>', 'Stores', stores, [...storeNames])
  .option('--top-k <number>', 'Returned chunks', integer(1, 100), 5)
  .option('--modality <type>', 'Common equality filter', modality)
  .option('--page <number>', 'Filter to physical demo PDF page', integer(1, 100000))
  .option('--answer', 'Call Bedrock Converse for each store', false)
  .option('--images', 'Include up to four retrieved page images in answers', false)
  .option('--output <file>', 'Save query result', '.vector-lab/query.json')
  .action(async (o) => {
    const c = await config(),
      data = await loadEmbedded(o.input, c),
      bedrock = new Bedrock(c),
      start = performance.now();
    const vector = await bedrock.embed(o.question),
      embeddingMs = performance.now() - start;
    const results = [];
    for (const name of o.stores) {
      const begin = performance.now(),
        response = await createStore(name, c).search(vector, o.topK, {
          corpus: data.corpus.id,
          modality: o.modality,
          page: o.page,
        });
      const retrievalMs = performance.now() - begin,
        answerStart = performance.now();
      const generation = o.answer ? await bedrock.answer(o.question, response.hits, o.images) : undefined;
      results.push({
        store: name,
        retrievalMs,
        ...response,
        generation,
        generationMs: generation ? performance.now() - answerStart : undefined,
      });
    }
    const report = { question: o.question, corpus: data.corpus.id, embeddingMs, embeddingMayBeCached: true, results };
    await writeJson(o.output, report);
    print(report);
  });
app
  .command('benchmark')
  .description('Measure retrieval latency, exact cosine recall, and labelled-page retrieval')
  .option('--input <file>', 'Embedded dataset', '.vector-lab/embedded.json')
  .option('--questions <file>', 'Question JSON', 'examples/questions-text.json')
  .option('--stores <names>', 'Stores', stores, [...storeNames])
  .option('--top-k <number>', 'Returned chunks', integer(1, 100), 5)
  .option('--rounds <number>', 'Measured rounds per question', integer(1, 10000), 5)
  .option('--warmup <number>', 'Extra unmeasured queries per store', integer(0, 100), 1)
  .option('--concurrency <number>', 'Concurrent queries per store batch', integer(1, 100), 1)
  .option(
    '--idle-seconds <number>',
    'Wait without store calls before first request (minimum 660 for cold experiments)',
    integer(0, 3600),
    0,
  )
  .option('--output <directory>', 'Report directory (default: new timestamped run)')
  .action(async (o) => {
    if (o.idleSeconds > 0 && o.idleSeconds < 660)
      throw new Error('Use --idle-seconds 660 or more to allow the 10-minute idle window.');
    const c = await config(),
      data = await loadEmbedded(o.input, c),
      questions = z.array(questionSchema).parse(await readJson(o.questions));
    const output = o.output ?? path.join(workDir, 'reports', new Date().toISOString().replace(/[:.]/g, '-'));
    const report = await benchmark(data, c, o.stores, questions, { ...o, output });
    print({ output: path.resolve(output), summary: report.summary });
    if (report.samples.some((s) => s.error)) process.exitCode = 1;
  });
app
  .command('metrics')
  .description('Read OpenSearch group OCU history through CloudWatch without waking it')
  .option('--minutes <number>', 'Lookback window', integer(1, 1440), 30)
  .action(async (o) => print(await metrics(await config(), o.minutes)));
app
  .command('usage')
  .description('Summarize locally recorded actual Bedrock token usage')
  .action(async () => {
    const lines = (await readFile(path.join(workDir, 'bedrock-usage.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (s) =>
          JSON.parse(s) as { operation: string; usage: { model: string; inputTokens?: number; outputTokens?: number } },
      );
    const totals: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {};
    for (const line of lines) {
      const key = `${line.operation}:${line.usage.model}`;
      const t = (totals[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      t.calls++;
      t.inputTokens += line.usage.inputTokens ?? 0;
      t.outputTokens += line.usage.outputTokens ?? 0;
    }
    print({
      totals,
      note: 'Local successfully logged Bedrock calls only; excludes failed calls, cloud storage/requests, and calls from other machines. Not an AWS bill.',
    });
  });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
export { app };
