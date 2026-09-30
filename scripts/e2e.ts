/**
 * E2E nyata satu shot:
 *   TTS Indonesia (audio.cpp omnivoice) → video test → seed library SFX →
 *   run job (whisper ONNX small) → transkrip → visual → manifest → picker →
 *   render final.mp4
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

process.env.WHISPER_ONNX_MODEL = 'onnx-community/whisper-small_timestamped';

const { DATA_DIR, SFX_DIR, ensureDirs } = await import('../src/config.js');
const { getDb, getJob, getJobEvents, listSfx } = await import('../src/db.js');
const { importSfx, saveSfxDescription, removeSfx } = await import('../src/sfx.js');
const { createApp } = await import('../src/server.js');

ensureDirs();
getDb();

function sh(cmd: string, args: string[]): Buffer {
  return execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
}

/* ---------- 1. TTS bicara Indonesia ---------- */
const REF = 'E:/project/movie2short/src/patrick_ref_voice.wav';
const REF_TXT = 'E:/project/movie2short/src/patrick_ref_voice.txt';
const ttsText =
  'Wah, ternyata pesta ini jauh lebih meriah dari yang aku bayangkan! ' +
  'Lihat, kue ulang tahunnya besar sekali. ' +
  'Ayo kita tiup lilinnya bersama-sama sekarang juga!';

async function tts(text: string, out: string): Promise<void> {
  const body: any = {
    model: 'omnivoice',
    input: text,
    response_format: 'wav',
    language: 'Indonesian',
  };
  if (fs.existsSync(REF)) {
    body.voice_ref = { type: 'base64', data: fs.readFileSync(REF).toString('base64') };
    if (fs.existsSync(REF_TXT)) body.reference_text = fs.readFileSync(REF_TXT, 'utf8').trim();
  }
  const res = await fetch('http://localhost:8080/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

console.log('--- 1. TTS Indonesia ---');
const speechWav = path.join(DATA_DIR, 'tmp', 'e2e_speech.wav');
await tts(ttsText, speechWav);
const speechDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', speechWav]).toString());
console.log('TTS OK:', speechDur.toFixed(1), 's');

/* ---------- 2. Video test ---------- */
console.log('--- 2. Video test ---');
const videoPath = path.join(DATA_DIR, 'uploads', 'e2e_test.mp4');
sh('ffmpeg', ['-hide_banner', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${Math.ceil(speechDur + 2)}`,
  '-i', speechWav,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  videoPath]);
console.log('video OK:', videoPath);

/* ---------- 3. Seed library SFX (deskripsi manusia) ---------- */
console.log('--- 3. Seed library ---');
const fixturesDir = path.join(DATA_DIR, 'tmp', 'e2e_sfx');
fs.mkdirSync(fixturesDir, { recursive: true });
const seeds: { name: string; text: string; make: () => string; desc: string; tags: string[]; cat: string }[] = [
  {
    name: 'boing.wav', cat: 'komedi', tags: ['komedi', 'boing'],
    desc: 'Suara boing karet elastis, pantulan lucu, komedi kartun',
    make: () => { const f = path.join(fixturesDir, 'boing.wav'); sh('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.7', '-af', 'acrusher=level_in=8:bits=4,asetnsamples=400,vibrato=f=8:d=0.6', f]); return f; },
  },
  {
    name: 'whoosh.wav', cat: 'transisi', tags: ['transisi', 'whoosh'],
    desc: 'Angin cepat whoosh melintas, transisi gerakan cepat',
    make: () => { const f = path.join(fixturesDir, 'whoosh.wav'); sh('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=0.9:c=pink:a=0.7', '-af', 'afade=t=in:d=0.3,afade=t=out:st=0.5:d=0.4,highpass=f=300', f]); return f; },
  },
  {
    name: 'ding.wav', cat: 'stinger', tags: ['ding', 'benar'],
    desc: 'Ding logam cerah, penekan ide atau jawaban benar',
    make: () => { const f = path.join(fixturesDir, 'ding.wav'); sh('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1200:duration=1.2', '-af', 'afade=t=out:st=0.4:d=0.8', f]); return f; },
  },
  {
    name: 'aduh_tunggu.wav', cat: 'vokal', tags: ['vokal', 'aduh', 'komedi'],
    desc: 'Suaranya bilang aduh tunggu, panik komedi, vokal',
    make: () => { const f = path.join(fixturesDir, 'aduh_tunggu.wav'); return f; }, // diisi TTS di bawah
  },
  {
    name: 'ambience_ruangan.wav', cat: 'ambience', tags: ['ambience', 'ruangan'],
    desc: 'Suasana ruangan ramai samar, latar pesta, ambience',
    make: () => { const f = path.join(fixturesDir, 'amb.wav'); sh('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=brown:a=0.25', '-af', 'lowpass=f=800', f]); return f; },
  },
];
const seeded: number[] = [];
for (const s of seeds) {
  let file: string;
  if (s.name === 'aduh_tunggu.wav') {
    file = path.join(fixturesDir, 'aduh_tunggu.wav');
    await tts('Aduh tunggu dong!', file);
  } else {
    file = s.make();
  }
  const row = await importSfx(s.name, fs.readFileSync(file));
  await saveSfxDescription(row.id, { description: s.desc, tags: s.tags, category: s.cat });
  seeded.push(row.id);
  console.log('seed:', row.id, s.name, row.duration_ms + 'ms', 'onset=' + row.onset_ms + 'ms');
}

/* ---------- 4. Jalankan server + job ---------- */
console.log('--- 4. Run job ---');
const app = createApp();
const srv: any = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${srv.address().port}`;

const runRes: any = await (await fetch(`${base}/api/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoPath, engine: 'onnx', prompt: 'Video pesta ulang tahun yang ceria, kasih SFX komedi di punchline dan transisi' }),
})).json();
const jobId = runRes.jobId;
console.log('jobId:', jobId);

let finalJob: any = null;
const t0 = Date.now();
let pollFails = 0;
while (Date.now() - t0 < 45 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    finalJob = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    pollFails = 0;
  } catch (e) {
    // ECONNRESET sesekali di localhost → jangan matikan seluruh e2e
    pollFails++;
    console.log(`\n[poll gagal ${pollFails}: ${(e as Error).message}]`);
    if (pollFails > 20) throw e;
    continue;
  }
  const last = finalJob.events[finalJob.events.length - 1];
  process.stdout.write(`\r[${finalJob.status}/${finalJob.stage}] ${last?.message ?? ''}          `);
  if (finalJob.status === 'done' || finalJob.status === 'error' || finalJob.status === 'canceled') break;
}
console.log('\nstatus akhir:', finalJob.status, finalJob.error || '');

/* ---------- 5. Verifikasi ---------- */
console.log('--- 5. Verifikasi ---');
const dir = path.join(DATA_DIR, 'output', 'jobs', jobId);
const readJson = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const fail = (m: string): never => { throw new Error('E2E GAGAL: ' + m); };

if (finalJob.status !== 'done') {
  for (const e of finalJob.events) console.log(` [${e.level}] ${e.message}`);
  fail(`job status=${finalJob.status} err=${finalJob.error}`);
}

const words = readJson('transcript.json');
console.log('transkrip:', words.length, 'kata →', words.slice(0, 8).map((w: any) => w.w).join(' '));
if (words.length < 8) fail('transkrip terlalu sedikit');

const beats = readJson('manifest.json');
console.log('manifest:', beats.length, 'beat');
if (beats.length < 1) fail('manifest kosong');

const { cues } = readJson('cue_list.json');
console.log('cues:', cues.length);
for (const c of cues) console.log(`  @${c.start}s ${path.basename(c.sfxFile)} gain=${c.gain} ${c.type} — ${c.reason}`);
if (cues.length < 1) fail('tidak ada cue SFX terpilih');

const outVideo = path.join(dir, 'final.mp4');
if (!fs.existsSync(outVideo)) fail('final.mp4 tidak ada');
const outDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outVideo]).toString());
console.log('final.mp4 durasi:', outDur.toFixed(1), 's (input', speechDur.toFixed(1), 's)');
if (Math.abs(outDur - (speechDur + 2)) > 2) fail('durasi output tidak wajar');

console.log('\n===== E2E LULUS ✓ =====');
await new Promise((r) => srv.close(r));
void listSfx;
void removeSfx;
void getJob;
void getJobEvents;
process.exit(0);
