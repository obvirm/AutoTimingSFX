import fs from 'node:fs';
import { extractFrames } from './ffmpeg.js';
import { chatVision } from './openai.js';
import { parseJsonLoose } from './util.js';

export interface VisualMoment {
  t: number;
  kind: string;
  desc: string;
}

/**
 * Analisis visual: frame kunci → VLM (ENV VLM_MODEL) → momen penting
 * (transisi, aksi, teks di layar, puncak emosi) sebagai anchor timing.
 */
export async function analyzeVisual(
  video: string,
  jobDir: string,
  durationSec: number,
  log: (m: string) => void
): Promise<VisualMoment[]> {
  const frames = await extractFrames(video, jobDir, durationSec);
  if (frames.length === 0) return [];
  log(`visual: ${frames.length} frame diekstrak`);

  const out: VisualMoment[] = [];
  const BATCH = 12;
  for (let i = 0; i < frames.length; i += BATCH) {
    const batch = frames.slice(i, i + BATCH);
    const b64: string[] = [];
    const labels: string[] = [];
    for (const f of batch) {
      b64.push(fs.readFileSync(f.file).toString('base64'));
      labels.push(`Frame pada t=${f.t}s`);
    }
    const prompt = [
      'Kamu analis video. Di bawah ini frame-frame berurutan dari satu video, masing-masing diberi timestamp detik.',
      'Identifikasi MOMEN VISUAL yang berguna untuk penempatan sound effect:',
      '- pergantian scene / transisi',
      '- aksi mendadak (lompat, jatuh, tampar, kejutan, masuknya objek)',
      '- ekspresi emosi kuat (kaget, takut, senang, sedih)',
      '- teks / judul / graphic muncul',
      '- puncak punchline atau beat komedi (dari konteks visual)',
      '',
      'Balas HANYA dengan JSON array:',
      '[{"t": <detik, float>, "kind": "transition|action|emotion|text|reveal|other", "desc": "<deskripsi singkat, max 15 kata>"}]',
      'Gunakan timestamp frame terdekat. Jangan mengarang momen yang tidak ada; array boleh kosong. Maksimal 8 momen per batch.',
      '',
      `Timestamp frame: ${batch.map((f) => f.t).join(', ')}`,
    ].join('\n');
    try {
      const raw = await chatVision(prompt, b64);
      const arr = parseJsonLoose<any[]>(raw);
      if (Array.isArray(arr)) {
        for (const m of arr) {
          const t = Number(m?.t);
          if (!Number.isFinite(t)) continue;
          out.push({
            t: Math.round(t * 10) / 10,
            kind: String(m?.kind ?? 'other'),
            desc: String(m?.desc ?? '').slice(0, 200),
          });
        }
      }
    } catch (e) {
      log(`visual: batch ${i / BATCH + 1} gagal — ${(e as Error).message}`);
    }
  }
  out.sort((a, b) => a.t - b.t);
  log(`visual: ${out.length} momen terdeteksi`);
  return out;
}
