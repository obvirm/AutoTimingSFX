import { describe, expect, it } from 'vitest';
import { tokenScore } from '../src/embedding.js';

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
