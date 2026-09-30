import { chatJson } from './openai.js';
import type { VisualMoment } from './visual.js';

export interface Beat {
  t: number;
  end: number;
  type: 'dialogue' | 'visual' | 'transition';
  context: string;
  notes: string;
}

/**
 * Manifest: gabung momen (video+audio dari VLM) + prompt user → daftar "beat"
 * (detik + konteks) yang layak diberi SFX.
 */
export async function buildManifest(opts: {
  events: VisualMoment[];
  durationSec: number;
  userPrompt: string;
  log: (m: string) => void;
}): Promise<Beat[]> {
  const { events, durationSec, userPrompt, log } = opts;

  const eventsBrief = events
    .map((v, i) => {
      const range = v.end !== undefined ? `${v.t}s-${v.end}s` : `${v.t}s`;
      return `[${i + 1}] ${range} (${v.kind}) ${v.desc}`;
    })
    .slice(0, 80)
    .join('\n');

  const sys = [
    'Kamu sound designer berpengalaman. Tugasmu: menemukan BEAT (titik momen) dalam video yang LAYAK diberi sound effect.',
    'Beat yang bagus: punchline komedi, reveal/kejutan, transisi scene, momen tegang, aksi visual kuat, puncak audio (teriakan/dentum), hook pembuka, dan penutup.',
    'Hindari beat di tengah momen biasa — SFX di sana akan berantakan.',
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
    'MOMEN (hasil analisis VLM, visual DAN audio, timestamp global):',
    eventsBrief || '(tidak ada momen terdeteksi — video kemungkinan sepi; balas {"beats":[]})',
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
