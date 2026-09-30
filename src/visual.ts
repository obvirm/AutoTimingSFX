import fs from 'node:fs';
import path from 'node:path';
import { extractVideoChunk } from './ffmpeg.js';
import { chatVideo } from './openai.js';
import { clamp, parseJsonLoose } from './util.js';

export interface VisualMoment {
  t: number;
  end?: number;
  kind: string;
  desc: string;
}

/** Panjang segmen video yang dikirim per request VLM (detik). */
export const CHUNK_SEC = 40;

export function chunkRanges(durationSec: number, chunkSec = CHUNK_SEC): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  if (!Number.isFinite(durationSec) || durationSec <= 0) return ranges;
  for (let s = 0; s < durationSec; s += chunkSec) {
    ranges.push({ start: Math.round(s * 100) / 100, end: Math.min(Math.round((s + chunkSec) * 100) / 100, durationSec) });
  }
  return ranges;
}

/**
 * Analisis VLM: video dipotong per CHUNK_SEC detik (AUDIO IKUT) → tiap segmen
 * dikirim sebagai data:video/mp4 base64 → momen visual + audio dengan
 * timestamp GLOBAL. Tidak ada transkripsi lokal — model mendengar sendiri.
 */
export async function analyzeVideo(
  video: string,
  jobDir: string,
  durationSec: number,
  log: (m: string) => void
): Promise<VisualMoment[]> {
  const ranges = chunkRanges(durationSec);
  if (ranges.length === 0) return [];

  const out: VisualMoment[] = [];
  let ok = 0;
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    const chunkFile = path.join(jobDir, `chunk_${String(i).padStart(3, '0')}.mp4`);
    log(`analisis: segmen ${i + 1}/${ranges.length} (${start}s-${end}s, video+audio)`);
    try {
      await extractVideoChunk(video, start, end - start, chunkFile);
      const b64 = fs.readFileSync(chunkFile).toString('base64');
      const prompt = [
        `Kamu analis video. Di bawah ini klip selama ${(end - start).toFixed(1)} detik dari sebuah video, AUDIONYA TERMASUK di klip ini.`,
        `Klip merepresentasikan rentang detik GLOBAL ${start} sampai ${end} (klip lokal mulai dari 0).`,
        '',
        'Temukan MOMEN yang berguna untuk penempatan sound effect — baik visual maupun audio:',
        '- pergantian scene / transisi',
        '- aksi mendadak (lompat, jatuh, tampar, kejutan, masuknya objek)',
        '- ekspresi emosi kuat / reaksi orang',
        '- teks / judul / graphic muncul',
        '- puncak punchline atau beat komedi',
        '- suara penting dari AUDIO: teriakan, tawa, dentum, musik mendadak, ucapan kunci, jeda dramatis',
        '',
        'Balas HANYA JSON array:',
        '[{"t": <detik GLOBAL, float>, "end": <detik GLOBAL akhir, opsional>, "kind": "transition|action|emotion|text|reveal|audio|other", "desc": "<deskripsi singkat, maks 20 kata>"}]',
        `t WAJIB di dalam rentang GLOBAL ${start}-${end} (t = posisi di klip + ${start}).`,
        'Jangan mengarang momen yang tidak ada; array boleh kosong. Maksimal 12 momen per klip.',
      ].join('\n');
      const raw = await chatVideo(prompt, b64);
      const arr = parseJsonLoose<any[]>(raw);
      if (Array.isArray(arr)) {
        ok++;
        for (const m of arr) {
          const t = Number(m?.t);
          if (!Number.isFinite(t)) continue;
          const gt = Math.round(clamp(t, start - 0.5, end + 0.5) * 10) / 10;
          const ev: VisualMoment = {
            t: gt,
            kind: String(m?.kind ?? 'other'),
            desc: String(m?.desc ?? '').slice(0, 200),
          };
          const e = Number(m?.end);
          if (Number.isFinite(e)) ev.end = Math.round(clamp(e, gt, end + 0.5) * 10) / 10;
          out.push(ev);
        }
      } else {
        log(`analisis: segmen ${i + 1} balasan bukan array`);
      }
    } catch (e) {
      log(`analisis: segmen ${i + 1} gagal — ${(e as Error).message}`);
    } finally {
      try {
        fs.unlinkSync(chunkFile);
      } catch {
        /* file mungkin belum terbentuk */
      }
    }
  }

  if (ranges.length > 0 && ok === 0) {
    throw new Error('analisis VLM gagal di semua segmen — cek VLM_MODEL / gateway');
  }
  out.sort((a, b) => a.t - b.t);
  log(`analisis: ${out.length} momen terdeteksi (video+audio)`);
  return out;
}
