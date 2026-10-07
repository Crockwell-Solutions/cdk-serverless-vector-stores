import { describe, expect, it } from 'vitest';
import { splitText } from '../src/pdf.js';
import { cosine, exactSearch, percentile, recallAtK, summarize, type Sample } from '../src/benchmark.js';
import { validateVector } from '../src/bedrock.js';
import { record } from './fixtures.js';
describe('PDF chunking', () => {
  it('preserves the end and bounded overlapping windows', () => {
    const text = '0123456789'.repeat(31),
      chunks = splitText(text, 100, 20);
    expect(chunks.every((v) => v.length <= 100)).toBe(true);
    expect(chunks[0]!.slice(-20)).toBe(chunks[1]!.slice(0, 20));
    expect(chunks.at(-1)!.endsWith(text.slice(-30))).toBe(true);
  });
  it('handles empty/scanned pages and rejects infinite-loop parameters', () => {
    expect(splitText('   ')).toEqual([]);
    expect(() => splitText('hello', 100, 100)).toThrow();
  });
});
describe('meaningful benchmark metrics', () => {
  const records = [record('a', [1, 0]), record('tied', [1, 0]), record('b', [0, 1]), record('image', [1, 0], 'image')];
  const filter = { corpus: 'sample', modality: 'text' as const };
  it('computes cosine and filters before exact top-k', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1);
    expect(exactSearch(records, [1, 0], 10, filter).map((r) => r.id)).toEqual(['a', 'tied', 'b']);
  });
  it('gives ties credit without duplicate credit or cross-filter leakage', () => {
    const expected = exactSearch(records, [1, 0], 1, filter);
    const hit = { ...records[1]!, score: 0, scoreKind: 'distance' as const };
    expect(recallAtK([hit], expected, records, [1, 0], filter)).toBe(1);
    expect(recallAtK([{ ...records[3]!, score: 0, scoreKind: 'distance' }], expected, records, [1, 0], filter)).toBe(0);
    expect(recallAtK([hit, hit], exactSearch(records, [1, 0], 2, filter), records, [1, 0], filter)).toBe(0.5);
    expect(recallAtK([], [], records, [1, 0], filter)).toBeNull();
  });
  it('keeps warmups, first requests and failures out of warm latency percentiles', () => {
    const sample: Sample = {
      store: 's3',
      question: 'q',
      phase: 'warm',
      round: 0,
      ms: 10,
      ids: [],
      pages: [],
      recall: 0,
      pageHit: false,
      reciprocalRank: 0,
    };
    const result = summarize([
      sample,
      { ...sample, phase: 'first', ms: 999 },
      { ...sample, phase: 'warmup', ms: 500 },
      { ...sample, ms: 800, error: 'throttled' },
    ]);
    expect(result.s3!.p95Ms).toBe(10);
    expect(result.s3!.errors).toBe(1);
    expect(result.s3!.requests).toBe(2);
    expect(result.s3!.meanRecallAtK).toBe(0);
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
  });
  it('rejects incompatible and invalid vectors', () => {
    expect(() => validateVector([0, 0], 2)).toThrow();
    expect(() => validateVector([NaN, 1], 2)).toThrow();
    expect(() => validateVector([1], 2)).toThrow();
    expect(() => cosine([1], [1, 2])).toThrow();
  });
});
