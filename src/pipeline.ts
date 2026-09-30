import fs from 'node:fs';
import path from 'node:path';
import { JOBS_DIR } from './config.js';
import {
  addJobEvent,
  getJob,
  getSfx,
  saveJobData,
  updateJob,
} from './db.js';
import { extractAudioWav, probeDuration } from './ffmpeg.js';
import { buildManifest } from './manifest.js';
import { pickSfx, type Cue } from './picker.js';
import { renderVideo } from './render.js';
import { transcribe, type Engine } from './transcribe/index.js';
import { analyzeVisual } from './visual.js';

const canceled = new Set<string>();

export function requestCancel(jobId: string): void {
  canceled.add(jobId);
}

export function jobDir(jobId: string): string {
  if (!/^[a-f0-9]{8,32}$/.test(jobId)) throw new Error('jobId tidak valid');
  return path.join(JOBS_DIR, jobId);
}

function log(jobId: string, msg: string): void {
  addJobEvent(jobId, msg);
  console.log(`[job ${jobId}] ${msg}`);
}

function checkCancel(jobId: string): void {
  if (canceled.has(jobId)) {
    canceled.delete(jobId);
    updateJob(jobId, { status: 'canceled', stage: 'canceled' });
    throw new Error('Dibatalkan user');
  }
}

/** Pipeline one-shot: transcribe → visual → manifest → pick → render. */
export async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error('job tidak ditemukan');
  const opts = JSON.parse(job.options || '{}') as { engine?: Engine };
  const engine: Engine = opts.engine === 'audiocpp' ? 'audiocpp' : 'onnx';
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });

  try {
    updateJob(jobId, { status: 'running', stage: 'probe' });
    log(jobId, `mulai (engine=${engine})`);
    const durationSec = await probeDuration(job.video_path);
    saveJobData(jobId, { durationSec });

    checkCancel(jobId);
    updateJob(jobId, { stage: 'extract-audio' });
    log(jobId, 'ekstrak audio...');
    const wav = await extractAudioWav(job.video_path);
    fs.copyFileSync(wav, path.join(dir, 'audio.wav'));

    checkCancel(jobId);
    updateJob(jobId, { stage: 'transcribe' });
    log(jobId, `transkripsi via ${engine}...`);
    const words = await transcribe(engine, wav);
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(words, null, 2));
    saveJobData(jobId, { wordCount: words.length });
    log(jobId, `transkrip: ${words.length} kata`);

    checkCancel(jobId);
    updateJob(jobId, { stage: 'visual' });
    const visual = await analyzeVisual(job.video_path, dir, durationSec, (m) => log(jobId, m));
    fs.writeFileSync(path.join(dir, 'visual.json'), JSON.stringify(visual, null, 2));

    checkCancel(jobId);
    updateJob(jobId, { stage: 'manifest' });
    const beats = await buildManifest({
      words,
      visual,
      durationSec,
      userPrompt: job.prompt,
      log: (m) => log(jobId, m),
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(beats, null, 2));

    checkCancel(jobId);
    updateJob(jobId, { stage: 'pick' });
    let cues = await pickSfx({
      beats,
      words,
      userPrompt: job.prompt,
      durationSec,
      log: (m) => log(jobId, m),
    });
    cues = resolveCueFiles(cues);
    fs.writeFileSync(path.join(dir, 'cue_list.json'), JSON.stringify({ cues }, null, 2));
    saveJobData(jobId, { cueCount: cues.length });

    checkCancel(jobId);
    updateJob(jobId, { stage: 'render' });
    log(jobId, `render ${cues.length} cue...`);
    await renderVideo({ video: job.video_path, cues, durationSec }, path.join(dir, 'final.mp4'));
    log(jobId, 'selesai ✓');

    updateJob(jobId, { status: 'done', stage: 'done', error: '' });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const cur = getJob(jobId);
    if (cur?.status !== 'canceled') {
      updateJob(jobId, { status: 'error', stage: cur?.stage ?? '', error: msg });
      addJobEvent(jobId, `ERROR: ${msg}`, 'error');
      console.error(`[job ${jobId}] ERROR`, e);
    }
  }
}

function resolveCueFiles(cues: Cue[]): Cue[] {
  return cues
    .map((c) => {
      const row = getSfx(c.sfxId);
      if (!row) return null;
      return { ...c, sfxFile: row.file_path };
    })
    .filter((c): c is Cue => c !== null);
}

/** Re-render dengan cue list hasil edit user (tanpa ulang pipeline AI). */
export async function rerenderJob(jobId: string, newCues: Cue[]): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error('job tidak ditemukan');
  const dir = jobDir(jobId);
  const durationSec = Number(JSON.parse(job.data || '{}').durationSec || 0);
  if (!durationSec) throw new Error('durationSec belum ada — jalankan pipeline dulu');
  const cues = resolveCueFiles(newCues).map((c, i) => ({ ...c, id: c.id || `r${i + 1}` }));
  updateJob(jobId, { stage: 'render', status: 'running', error: '' });
  try {
    fs.writeFileSync(path.join(dir, 'cue_list.json'), JSON.stringify({ cues }, null, 2));
    saveJobData(jobId, { cueCount: cues.length });
    log(jobId, `re-render ${cues.length} cue (edit manual)...`);
    await renderVideo({ video: job.video_path, cues, durationSec }, path.join(dir, 'final.mp4'));
    log(jobId, 're-render selesai ✓');
    updateJob(jobId, { status: 'done', stage: 'done' });
  } catch (e) {
    const msg = (e as Error).message;
    updateJob(jobId, { status: 'error', error: msg });
    addJobEvent(jobId, `ERROR: ${msg}`, 'error');
  }
}
