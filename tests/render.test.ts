import { describe, expect, it } from 'vitest';
import { buildFilterGraph } from '../src/render.js';
import type { Cue } from '../src/picker.js';

function cue(partial: Partial<Cue>): Cue {
  return {
    id: 'c1',
    start: 1.5,
    sfxId: 1,
    sfxFile: 'C:/sfx/boing.wav',
    gain: 0.5,
    leadMs: -120,
    anchorT: 1.62,
    type: 'impact',
    reason: 'uji',
    ...partial,
  };
}

describe('buildFilterGraph', () => {
  it('tanpa cue → null', () => {
    expect(buildFilterGraph([], 10)).toBeNull();
  });

  it('1 cue: tanpa amix bus, adelay ms dari start, gain linear, ducking tetap ada', () => {
    const fg = buildFilterGraph([cue({ start: 1.5, gain: 0.5 })], 6.4)!;
    expect(fg).toContain('[0:a]asplit=2[dial][key]');
    expect(fg).toContain('adelay=1500|1500:all=1');
    expect(fg).toContain('volume=0.5000');
    expect(fg).toContain('apad[busraw]');
    expect(fg).not.toContain('amix=inputs=2:normalize=0:duration=longest[busraw]');
    expect(fg).toContain('atrim=0:6.400');
    expect(fg).toContain('sidechaincompress=threshold=0.03:ratio=8');
    expect(fg).toContain('[dial][duck]amix=inputs=2:normalize=0:duration=first[outa]');
  });

  it('2 cue: bus diamix normalize=0 sebelum duck', () => {
    const fg = buildFilterGraph([cue({ id: 'a', start: 1 }), cue({ id: 'b', start: 3, gain: 0.8 })], 8)!;
    expect(fg).toContain('adelay=1000|1000:all=1');
    expect(fg).toContain('adelay=3000|3000:all=1');
    expect(fg).toContain('[s0][s1]amix=inputs=2:normalize=0:duration=longest[busraw]');
    expect(fg).toContain('volume=0.8000');
    expect(fg).toContain('atrim=0:8.000');
  });

  it('start negatif dibuang ke 0', () => {
    const fg = buildFilterGraph([cue({ start: -0.4 })], 5)!;
    expect(fg).toContain('adelay=0|0:all=1');
  });

  it('mapping input SFX mengikuti urutan cue (i+1)', () => {
    const fg = buildFilterGraph([cue({ id: 'a' }), cue({ id: 'b' }), cue({ id: 'c' })], 9)!;
    expect(fg).toContain('[1:a]aformat');
    expect(fg).toContain('[2:a]aformat');
    expect(fg).toContain('[3:a]aformat');
    expect(fg).toContain('[s0][s1][s2]amix=inputs=3');
  });
});
