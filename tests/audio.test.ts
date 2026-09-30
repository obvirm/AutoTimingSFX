import { describe, expect, it } from 'vitest';
import { tokenScore } from '../src/embedding.js';
import { normalizeWords } from '../src/transcribe/audiocpp.js';

describe('tokenScore (fallback pencarian tanpa embedding)', () => {
  it('kueri cocok sempurna skornya tinggi', () => {
    const hi = tokenScore('whoosh transisi cepat', 'whoosh transisi cepat untuk zoom kamera');
    const lo = tokenScore('whoosh transisi cepat', 'dentum ledakan keras');
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeGreaterThan(0.5);
  });

  it('tidak ada irisan → 0', () => {
    expect(tokenScore('whoosh', 'ledakan keras')).toBe(0);
  });

  it('kueri kosong → 0', () => {
    expect(tokenScore('', 'apa saja')).toBe(0);
  });
});

describe('normalizeWords (audio.cpp → bentuk umum)', () => {
  it('bentuk {word,start,end}', () => {
    const out = normalizeWords({ words: [{ word: ' halo', start: 0, end: 0.4 }] });
    expect(out).toEqual([{ w: 'halo', start: 0, end: 0.4 }]);
  });

  it('segmen + words di dalamnya', () => {
    const out = normalizeWords({
      segments: [{ start: 1, end: 2, words: [{ text: 'dunia', start: 1, end: 1.5 }] }],
    });
    expect(out).toEqual([{ w: 'dunia', start: 1, end: 1.5 }]);
  });

  it('tanpa timestamp → sebar rata di segmen', () => {
    const out = normalizeWords({ segments: [{ start: 0, end: 3, text: 'satu dua' }] });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ w: 'satu', start: 0, end: 1.5 });
    expect(out[1]).toEqual({ w: 'dua', start: 1.5, end: 3 });
  });

  it('diurutkan start naik', () => {
    const out = normalizeWords({
      words: [
        { word: 'b', start: 2, end: 2.4 },
        { word: 'a', start: 0, end: 0.4 },
      ],
    });
    expect(out.map((x) => x.w)).toEqual(['a', 'b']);
  });
});
