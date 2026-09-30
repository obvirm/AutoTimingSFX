import { describe, expect, it } from 'vitest';
import { CHUNK_SEC, chunkRanges } from '../src/visual.js';

describe('chunkRanges (pemotongan video untuk VLM)', () => {
  it('video pendek → 1 segmen', () => {
    expect(chunkRanges(12)).toEqual([{ start: 0, end: 12 }]);
  });

  it('video pas 40 dtk → 1 segmen penuh', () => {
    expect(chunkRanges(CHUNK_SEC)).toEqual([{ start: 0, end: 40 }]);
  });

  it('video > 40 dtk → segmen 40 dtk + sisa', () => {
    expect(chunkRanges(41)).toEqual([
      { start: 0, end: 40 },
      { start: 40, end: 41 },
    ]);
  });

  it('video panjang → rentang saling sambung, tanpa celah/tumpang-tindih', () => {
    const ranges = chunkRanges(95);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toEqual({ start: 0, end: 40 });
    expect(ranges[1]).toEqual({ start: 40, end: 80 });
    expect(ranges[2]).toEqual({ start: 80, end: 95 });
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end);
    }
  });

  it('durasi tidak valid → []', () => {
    expect(chunkRanges(0)).toEqual([]);
    expect(chunkRanges(-5)).toEqual([]);
    expect(chunkRanges(Number.NaN)).toEqual([]);
  });
});
