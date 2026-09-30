import { describe, expect, it } from 'vitest';
import { wordsToSegments } from '../src/manifest.js';
import type { Word } from '../src/transcribe/audiocpp.js';

function w(text: string, start: number, end: number): Word {
  return { w: text, start, end };
}

describe('wordsToSegments', () => {
  it('kata berdekatan digabung jadi 1 segmen', () => {
    const segs = wordsToSegments([
      w('halo', 0, 0.3),
      w('dunia', 0.4, 0.8),
      w('selamat', 1.0, 1.4),
      w('datang', 1.5, 1.9),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('halo dunia selamat datang');
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(1.9);
    expect(segs[0].words).toHaveLength(4);
  });

  it('jeda > gapSec memecah segmen', () => {
    const segs = wordsToSegments([w('satu', 0, 0.3), w('dua', 5, 5.4)], 0.9);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe('satu');
    expect(segs[1].text).toBe('dua');
    expect(segs[1].start).toBe(5);
  });

  it('input kosong → []', () => {
    expect(wordsToSegments([])).toEqual([]);
  });
});
