import { chatJson } from './openai.js';
import type { Word } from './transcribe/audiocpp.js';

export interface Beat {
  t: number;
  end: number;
  type: 'dialogue' | 'visual' | 'transition';
  context: string;
  notes: string;
}

/** Kelompokkan word → segmen percakapan (gap > 0.9s = segmen baru). */
export function wordsToSegments(words: Word[], gapSec = 0.9): { text: string; start: number; end: number; words: Word[] }[] {
  const segs: { text: string; start: number; end: number; words: Word[] }[] = [];
  let cur: Word[] = [];
  for (const w of words) {
    if (cur.length === 0 || w.start - cur[cur.length - 1].end <= gapSec) cur.push(w);
    else {
      segs.push(mkSeg(cur));
      cur = [w];
    }
  }
  if (cur.length) segs.push(mkSeg(cur));
  return segs;
}

function mkSeg(ws: Word[]): { text: string; start: number; end: number; words: Word[] } {
  return {
    text: ws.map((w) => w.w).join(' '),
    start: ws[0].start,
    end: ws[ws.length - 1].end,
    words: ws,
  };
}

/**
 * Manifest: gabung transcript + momen visual + prompt user → daftar "beat"
 * (detik + konteks) yang layak diberi SFX.
 */
export async function buildManifest(opts: {
  words: Word[];
  visual: { t: number; kind: string; desc: string }[];
  durationSec: number;
  userPrompt: string;
  log: (m: string) => void;
}): Promise<Beat[]> {
  const { words, visual, durationSec, userPrompt, log } = opts;
  const segs = wordsToSegments(words);

  const transcriptBrief = segs
    .map((s, i) => `[${i + 1}] ${s.start.toFixed(1)}s-${s.end.toFixed(1)}s: ${s.text}`)
    .slice(0, 120)
    .join('\n');
  const visualBrief = visual
    .map((v, i) => `[${i + 1}] ${v.t}s (${v.kind}) ${v.desc}`)
    .slice(0, 60)
    .join('\n');

  const sys = [
    'Kamu sound designer berpengalaman. Tugasmu: menemukan BEAT (titik momen) dalam video yang LAYAK diberi sound effect.',
    'Beat yang bagus: punchline komedi, reveal/kejutan, transisi scene, momen tegang, aksi visual kuat, hook pembuka, dan penutup.',
    'Hindari beat di tengah kalimat biasa — SFX di sana akan berantakan.',
    '',
    `Video berdurasi ${durationSec.toFixed(1)} detik. Maksimal 40 beat, diurutkan menaik.`,
    userPrompt ? `Panduan tambahan dari user: ${userPrompt}` : '',
    '',
    'Balas HANYA JSON:',
    '{"beats":[{"t":<detik_awal>,"end":<detik_akhir>,"type":"dialogue"|"visual"|"transition","context":"apa yang terjadi","notes":"saran suasana SFX, bahasa Indonesia singkat"}]}',
  ]
    .filter(Boolean)
    .join('\n');

  const user = [
    'TRANSCRIPT (word-accurate, per segmen):',
    transcriptBrief || '(tidak ada transkrip)',
    '',
    'MOMEN VISUAL:',
    visualBrief || '(tidak ada analisis visual)',
  ].join('\n');

  const j = await chatJson<{ beats: Beat[] }>([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]);
  const beats = (Array.isArray(j?.beats) ? j.beats : [])
    .filter((b) => Number.isFinite(Number(b?.t)) && Number(b.t) >= 0 && Number(b.t) <= durationSec + 1)
    .map((b) => ({
      t: Math.round(Number(b.t) * 100) / 100,
      end: Math.round(Number(b.end || Number(b.t) + 1) * 100) / 100,
      type: (['dialogue', 'visual', 'transition'] as const).includes(b.type) ? b.type : 'dialogue',
      context: String(b.context ?? ''),
      notes: String(b.notes ?? ''),
    }))
    .sort((a, b) => a.t - b.t);
  log(`manifest: ${beats.length} beat`);
  return beats;
}
