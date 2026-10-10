import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Local generated artifacts and caches, relative to the CLI's working directory.
 */
export const workDir = path.resolve('.vector-lab');

/**
 * Produce a stable SHA-256 key for serialized content or configuration.
 */
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Hash a file as a stream so large PDFs do not need to fit in memory.
 */
export async function fileHash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }

  return digest.digest('hex');
}

/**
 * Read JSON as unknown so callers can apply their own schema validation.
 */
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Write formatted JSON via a temporary sibling file, then replace the destination.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rename(temp, file);
}

/**
 * Reuse an existing JSON cache, building it only when the file does not exist.
 */
export async function cached<T>(file: string, build: () => Promise<T>): Promise<T> {
  try {
    return (await readJson(file)) as T;
  } catch (e) {
    // Invalid JSON and access failures must surface rather than silently rebuilding the cache.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  const value = await build();
  await writeJson(file, value);
  return value;
}

/**
 * Pause without blocking the event loop.
 */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll a readiness check until it succeeds or its timeout is reached.
 */
export async function waitFor(
  description: string,
  ready: () => Promise<boolean>,
  timeoutMs = 900_000,
  intervalMs = 5000,
) {
  const end = Date.now() + timeoutMs;
  do {
    if (await ready()) {
      return;
    }
    await sleep(intervalMs);
  } while (Date.now() < end);

  throw new Error(`Timed out waiting for ${description}; rerun init to resume.`);
}
