import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileHash, hash, workDir, writeJson } from './io.js';
import type { Chunk, Corpus } from './types.js';

const exec = promisify(execFile);

/**
 * Split normalized page text into overlapping character chunks, preferring nearby line breaks.
 */
export function splitText(text: string, size = 1800, overlap = 200): string[] {
  if (
    !Number.isInteger(size) ||
    size < 100 ||
    size > 4000 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= size
  ) {
    throw new Error('Chunk size must be 100-4000 characters; overlap must be smaller and nonnegative.');
  }

  const normalized = text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length;) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      // Prefer a line break only when it preserves at least half the target chunk length.
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > start + size / 2) {
        end = boundary;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end === normalized.length) {
      break;
    }
    start = end - overlap;
  }

  return chunks;
}

/**
 * Read PDF metadata with Poppler and report a useful dependency hint when inspection fails.
 */
export async function inspectPdf(pdf: string) {
  try {
    const { stdout } = await exec('pdfinfo', [pdf]);
    const total = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!total) {
      throw new Error('Could not determine PDF page count');
    }

    return { total, info: stdout };
  } catch (e) {
    throw new Error(
      `Unable to inspect PDF. Install Poppler (brew install poppler / apt install poppler-utils). ${String(e)}`,
    );
  }
}

/**
 * Cache layout-preserving text by PDF checksum and split it at Poppler's page separators.
 */
export async function extractText(pdf: string, sha: string) {
  const output = path.join(workDir, 'pdf', `${sha}.txt`);
  await mkdir(path.dirname(output), { recursive: true });
  try {
    await access(output);
  } catch {
    // Publish the cache only after extraction succeeds, leaving incomplete output out of use.
    await exec('pdftotext', ['-layout', pdf, `${output}.tmp`], { maxBuffer: 1024 * 1024 });
    const { rename } = await import('node:fs/promises');
    await rename(`${output}.tmp`, output);
  }

  return (await readFile(output, 'utf8')).split('\f');
}

/**
 * Prepare every page of a PDF as text chunks and optional page images for later embedding.
 */
export async function prepare(pdf: string, images: boolean, size = 1800, overlap = 200): Promise<Corpus> {
  // Validate chunk settings before running external PDF tools or writing artifacts.
  splitText('', size, overlap);
  const { total } = await inspectPdf(pdf);
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  const sha = await fileHash(pdf);
  const renderSize = 2000;
  // Content and preparation settings determine the corpus identity and downstream cache keys.
  const id = hash(JSON.stringify({ sha, pages, images, size, overlap, renderSize, version: 1 })).slice(0, 24);
  const textPages = await extractText(pdf, sha);
  const corpus: Corpus = {
    schema: 1,
    id,
    pdf: path.resolve(pdf),
    pdfSha256: sha,
    totalPages: total,
    pages,
    chunkChars: size,
    overlap,
    renderSize,
    chunks: [],
    images: [],
  };

  for (const page of pages) {
    const prefix = path.join(workDir, 'images', sha, `page-${page}`);
    if (images) {
      await mkdir(path.dirname(prefix), { recursive: true });
      try {
        await access(`${prefix}.jpg`);
      } catch {
        // Render the whole page so diagrams, captions, and spatial context remain together.
        await exec(
          'pdftoppm',
          [
            '-f',
            String(page),
            '-l',
            String(page),
            '-scale-to',
            String(renderSize),
            '-singlefile',
            '-jpeg',
            pdf,
            prefix,
          ],
          { maxBuffer: 1024 * 1024 },
        );
      }
      corpus.images.push({ page, path: `${prefix}.jpg` });
    }

    // PDF page numbers are one-based; extracted text is indexed from zero.
    for (const [i, text] of splitText(textPages[page - 1] ?? '', size, overlap).entries()) {
      const chunk: Chunk = {
        id: `${id}-p${page}-t${i}`,
        corpus: id,
        source: path.basename(pdf),
        page,
        modality: 'text',
        text,
      };
      if (images) {
        chunk.imagePath = `${prefix}.jpg`;
        chunk.imageKey = `corpora/${id}/pages/${page}.jpg`;
      }
      corpus.chunks.push(chunk);
    }
  }

  if (!corpus.chunks.length && !corpus.images.length) {
    throw new Error('No extractable text. Rerun prepare with --images for scanned pages.');
  }

  await writeJson(path.join(workDir, 'corpora', id, 'corpus.json'), corpus);
  return corpus;
}
