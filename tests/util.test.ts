import { describe, expect, it } from 'vitest';
import { clamp, cosine, fmtTime, parseJsonLoose } from '../src/util.js';

describe('parseJsonLoose', () => {
  it('JSON polos', () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('JSON dalam code fence', () => {
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('prefix teks + JSON', () => {
    expect(parseJsonLoose<{ a: number }>('Tentu, ini JSON-nya:\n{"a":3} semoga membantu')).toEqual({ a: 3 });
  });

  it('array di tengah teks', () => {
    expect(parseJsonLoose<number[]>('hasil: [1,2,3]')).toEqual([1, 2, 3]);
  });

  it('bukan JSON → lempar error', () => {
    expect(() => parseJsonLoose('ini bukan json')).toThrow();
  });
});

describe('clamp', () => {
  it('batas bawah/atas/dalam', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('fmtTime', () => {
  it('format mm:ss.cc', () => {
    expect(fmtTime(0)).toBe('00:00.00');
    expect(fmtTime(65.4)).toBe('01:05.40');
  });
});

describe('cosine', () => {
  it('vektor identik = 1', () => {
    expect(cosine(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1, 5);
  });
  it('vektor tegak lurus = 0', () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 5);
  });
  it('berlawanan arah = -1', () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1, 5);
  });
});
