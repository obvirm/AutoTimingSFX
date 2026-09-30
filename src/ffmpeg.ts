import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TMP_DIR } from './config.js';

export function runFfmpeg(args: string[], timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`ffmpeg timeout: ${args.join(' ')}`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out + err);
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-800)}`));
    });
  });
}

export function runFfprobe(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      file,
    ]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(e);
        }
      } else reject(new Error(`ffprobe exit ${code}: ${err.slice(-400)}`));
    });
  });
}

export async function probeDuration(file: string): Promise<number> {
  const j = await runFfprobe(file);
  return Number(j?.format?.duration ?? 0);
}

/** Ekstrak audio → WAV mono 16kHz (untuk whisper). */
export async function extractAudioWav(video: string): Promise<string> {
  const out = path.join(TMP_DIR, `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
  await runFfmpeg(['-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
  return out;
}

/** Baca WAV PCM16 mono menjadi Float32Array (sample rate diembalikan). */
export async function readWavMono(file: string): Promise<{ data: Float32Array; sr: number }> {
  const buf = fs.readFileSync(file);
  // cari chunk 'data'
  let pos = 12;
  let sr = 16000;
  let channels = 1;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      sr = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('WAV: chunk data tidak ditemukan');
  const bytes = Math.min(dataLen, buf.length - dataOff);
  const n = Math.floor(bytes / 2);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  void channels;
  void bits;
  return { data: f, sr };
}

/** Decode audio apa pun → Float32 mono @ 16k via ffmpeg pipe. */
export async function readAudioMono16k(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-i', file,
      '-vn', '-ac', '1', '-ar', '16000',
      '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode exit ${code}: ${err.slice(-400)}`));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

export interface SfxAnalysis {
  duration_ms: number;
  lufs: number;
  onset_ms: number;
  peak_db: number;
}

/**
 * Analisis SFX:
 * - duration_ms via ffprobe
 * - lufs via loudnorm satu pass (print_format json)
 * - onset_ms = jendela RMS pertama yang mencapai 30% dari RMS maks
 *   (waktu "serangan" suara — kunci untuk anchor timing presisi)
 */
export async function analyzeSfx(file: string): Promise<SfxAnalysis> {
  const dur = Math.round((await probeDuration(file)) * 1000);
  let lufs = -23;
  try {
    const out = await runFfmpeg(['-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
    const m = out.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (j.input_i && j.input_i !== '-inf') lufs = Number(j.input_i);
    }
  } catch {
    /* loudnorm gagal → default */
  }
  const pcm = await readAudioMono16k(file);
  const win = 160; // 10ms @16k
  const rms: number[] = [];
  for (let i = 0; i + win <= pcm.length; i += win) {
    let s = 0;
    for (let k = 0; k < win; k++) s += pcm[i + k] * pcm[i + k];
    rms.push(Math.sqrt(s / win));
  }
  let max = 0;
  for (const v of rms) if (v > max) max = v;
  let onsetMs = 0;
  const thr = max * 0.3;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] >= thr) {
      onsetMs = Math.round((i * win) / 16);
      break;
    }
  }
  const peakDb = max > 0 ? 20 * Math.log10(max) : -60;
  return { duration_ms: dur, lufs: Math.round(lufs * 10) / 10, onset_ms: onsetMs, peak_db: Math.round(peakDb * 10) / 10 };
}

/** Ambil frame kunci dari video untuk VLM. */
export async function extractFrames(video: string, jobDir: string, durationSec: number): Promise<{ file: string; t: number }[]> {
  const framesDir = path.join(jobDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const target = Math.min(40, Math.max(8, Math.ceil(durationSec / 4)));
  const fps = target / Math.max(durationSec, 1);
  await runFfmpeg([
    '-i', video,
    '-vf', `fps=${fps.toFixed(6)},scale=640:-2`,
    '-q:v', '5',
    path.join(framesDir, 'f_%04d.jpg'),
  ]);
  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  return files.map((f, i) => ({
    file: path.join(framesDir, f),
    t: Math.round(((i + 0.5) / fps) * 10) / 10,
  }));
}
