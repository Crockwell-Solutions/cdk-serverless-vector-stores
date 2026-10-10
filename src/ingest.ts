import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Bedrock, validateVector, VISION_PROMPT_VERSION } from './bedrock.js';
import { awsConfig } from './config.js';
import { hash, readJson, workDir, writeJson } from './io.js';
import { splitText } from './pdf.js';
import { createStore } from './stores/index.js';
import { type Corpus, type EmbeddedCorpus, type LabConfig, type StoreName, embeddedSchema } from './types.js';

/**
 * Embeds text and optional page captions once, producing the common input for every vector store.
 */
export async function embedCorpus(corpus: Corpus, config: LabConfig, vision: boolean): Promise<EmbeddedCorpus> {
  if (vision && !corpus.images.length) {
    throw new Error('Run prepare --images before embed --vision.');
  }

  const bedrock = new Bedrock(config);

  // Give each preparation/model combination its own record and image namespace.
  const id = hash(
    JSON.stringify({
      source: corpus.id,
      embedding: config.embeddingModel,
      dimensions: config.dimensions,
      vision: vision ? config.chatModel : null,
      prompt: VISION_PROMPT_VERSION,
    }),
  ).slice(0, 24);
  const chunks = corpus.chunks.map((c) => ({
    ...c,
    id: c.id.replace(corpus.id, id),
    corpus: id,
    imageKey: c.imageKey?.replace(corpus.id, id),
  }));

  // Image records contain embedded descriptions, with links back to the original rendered pages.
  if (vision) {
    for (const image of corpus.images) {
      console.error(`Describing PDF page ${image.page} (cached on repeat runs)`);
      const caption = await bedrock.describeImage(
        image.path,
        corpus.chunks
          .filter((c) => c.page === image.page)
          .map((c) => c.text)
          .join('\n'),
      );
      for (const [i, text] of splitText(caption, corpus.chunkChars, corpus.overlap).entries()) {
        chunks.push({
          id: `${id}-p${image.page}-i${i}`,
          corpus: id,
          page: image.page,
          source: path.basename(corpus.pdf),
          modality: 'image',
          text,
          imagePath: image.path,
          imageKey: `corpora/${id}/pages/${image.page}.jpg`,
        });
      }
    }
  }

  // Bedrock's per-input cache allows interrupted embedding runs to reuse completed model calls.
  const records = [];
  for (const [i, chunk] of chunks.entries()) {
    const vector = await bedrock.embed(chunk.text);
    records.push({ ...chunk, vector });
    if ((i + 1) % 10 === 0) {
      console.error(`Embedded ${i + 1}/${chunks.length} chunks`);
    }
  }

  const result: EmbeddedCorpus = {
    schema: 1,
    corpus: { ...corpus, id, chunks },
    embeddingModel: config.embeddingModel,
    dimensions: config.dimensions,
    visionModel: vision ? config.chatModel : null,
    records,
  };
  await writeJson(path.join(workDir, 'corpora', id, 'embedded.json'), result);
  return result;
}

/**
 * Checks index compatibility and record identity before any ingestion writes occur.
 */
export function assertCompatible(data: EmbeddedCorpus, config: LabConfig) {
  if (data.embeddingModel !== config.embeddingModel || data.dimensions !== config.dimensions) {
    throw new Error('Embedding model/dimensions do not match deployed indexes.');
  }

  if (!data.records.length) {
    throw new Error('Embedded corpus is empty.');
  }

  const ids = new Set<string>();
  for (const record of data.records) {
    validateVector(record.vector, config.dimensions);
    if (record.corpus !== data.corpus.id || ids.has(record.id)) {
      throw new Error('Invalid corpus identity or duplicate record ID.');
    }

    ids.add(record.id);
  }
}

/**
 * Loads the saved corpus, validating both its file schema and compatibility with this deployment.
 */
export async function loadEmbedded(file: string, config: LabConfig) {
  const data = embeddedSchema.parse(await readJson(file));
  assertCompatible(data, config);
  return data;
}

/**
 * Uploads page images and resumes batched writes independently for each selected store.
 */
export async function ingest(data: EmbeddedCorpus, config: LabConfig, names: StoreName[], force: boolean) {
  assertCompatible(data, config);
  const s3 = new S3Client(awsConfig(config));

  // Resume only when both the destination configuration and all records match the previous run.
  const runHash = hash(JSON.stringify({ config, records: data.records }));
  const checkpointFile = path.join(workDir, 'checkpoints', `${runHash}.json`);
  let checkpoint: { uploaded: string[]; stores: Partial<Record<StoreName, number>> } = { uploaded: [], stores: {} };
  if (!force) {
    try {
      checkpoint = (await readJson(checkpointFile)) as typeof checkpoint;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }

  // Shared page images may be referenced by many records; checkpoint each successful upload once.
  for (const record of data.records) {
    if (record.imagePath && record.imageKey && !checkpoint.uploaded.includes(record.imageKey)) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.assetsBucket,
          Key: record.imageKey,
          Body: await readFile(record.imagePath),
          ContentType: 'image/jpeg',
        }),
      );
      checkpoint.uploaded.push(record.imageKey);
      await writeJson(checkpointFile, checkpoint);
    }
  }

  for (const name of names) {
    const store = createStore(name, config);
    await store.init();
    for (let offset = checkpoint.stores[name] ?? 0; offset < data.records.length; offset += 100) {
      const batch = data.records.slice(offset, offset + 100);
      const start = performance.now();
      await store.upsert(batch);

      // Advance only after a successful batch. An interrupted batch may be safely upserted again.
      checkpoint.stores[name] = offset + batch.length;
      await writeJson(checkpointFile, checkpoint);
      console.error(
        `${name}: ${offset + batch.length}/${data.records.length} (${Math.round(performance.now() - start)} ms for ${batch.length} writes)`,
      );
    }
  }

  // This summary is written only after every selected store has completed its records.
  await writeJson(path.join(workDir, 'last-ingest.json'), {
    completedAt: new Date().toISOString(),
    corpus: data.corpus.id,
    records: data.records.length,
    stores: names,
    checkpoint: checkpointFile,
  });
}
