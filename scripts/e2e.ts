/**
 * E2E nyata satu shot:
 *   video test (potongan adegan + suara) → analisis VLM (video+audio, tanpa transkrip) →
 *   manifest beat → seed library SFX → picker (RAG) → render final.mp4
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { DATA_DIR, ensureDirs } = await import('../src/config.js');
const { getDb, getJobEvents } = await import('../src/db.js');
const { importSfx, saveSfxDescription, removeSfx } = await import('../src/sfx.js');
const { createApp } = await import('../src/server.js');

ensureDirs();
getDb();

function sh(cmd: string, args: string[]): Buffer {
  return execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
}

/* ---------- 1. Video test: 4 adegan warna berbeda + beep di tiap pergantian ---------- */
console.log('--- 1. Video test ---');
const videoPath = path.join(DATA_DIR, 'uploads', 'e2e_test.mp4');
sh('ffmpeg', [
  '-hide_banner', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x101820:size=640x360:rate=25:duration=3',
  '-f', 'lavfi', '-i', 'color=c=0xd97706:size=640x360:rate=25:duration=3',
  '-f', 'lavfi', '-i', 'smptehdbars=size=640x360:rate=25:duration=3',
  '-f', 'lavfi', '-i', 'color=c=0x7c3aed:size=640x360:rate=25:duration=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
  '-filter_complex',
  "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a]volume='if(between(t,2.8,3.3)+between(t,5.8,6.3)+between(t,8.8,9.3),1,0)':eval=frame[a]",
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoPath,
]);
const videoDur = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]).toString()
);
console.log('video OK:', videoPath, videoDur.toFixed(1), 's (4 adegan + beep)');

/* ---------- 2. Seed library SFX (deskripsi manusia) ---------- */
console.log('--- 2. Seed library ---');
const fixturesDir = path.join(DATA_DIR, 'tmp', 'e2e_sfx');
fs.mkdirSync(fixturesDir, { recursive: true });
const seeds: { name: string; make: () => string; desc: string; tags: string[]; cat: string }[] = [
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
    make: () => { const f = path.join(fixturesDir, 'aduh_tunggu.wav'); sh('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1.4', '-af', 'asetnsamples=500,vibrato=f=6:d=0.5,bandpass=f=900:width_type=h:w=400', f]); return f; },
  },
  {
    name: 'ambience_ruangan.wav', cat: 'ambience', tags: ['ambience', 'ruangan'],
    desc: 'Suasana ruangan ramai samar, latar pesta, ambience',
    make: () => { const f = path.join(fixturesDir, 'amb.wav'); sh('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=brown:a=0.25', '-af', 'lowpass=f=800', f]); return f; },
  },
];
const seeded: number[] = [];
for (const s of seeds) {
  const file = s.make();
  const row = await importSfx(s.name, fs.readFileSync(file));
  await saveSfxDescription(row.id, { description: s.desc, tags: s.tags, category: s.cat });
  seeded.push(row.id);
  console.log('seed:', row.id, s.name, row.duration_ms + 'ms', 'onset=' + row.onset_ms + 'ms');
}

/* ---------- 3. Jalankan server + job ---------- */
console.log('--- 3. Run job ---');
const app = createApp();
const srv: any = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${srv.address().port}`;

const runRes: any = await (await fetch(`${base}/api/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoPath, prompt: 'Video pergantian adegan berwarna, kasih SFX transisi di tiap potongan dan stinger penutup' }),
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

/* ---------- 4. Verifikasi ---------- */
console.log('--- 4. Verifikasi ---');
const dir = path.join(DATA_DIR, 'output', 'jobs', jobId);
const readJson = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
const fail = (m: string): never => { throw new Error('E2E GAGAL: ' + m); };

if (finalJob.status !== 'done') {
  for (const e of finalJob.events) console.log(` [${e.level}] ${e.message}`);
  fail(`job status=${finalJob.status} err=${finalJob.error}`);
}

const events = readJson('events.json');
console.log('events:', events.length, 'momen →', events.slice(0, 8).map((e: any) => `${e.t}s(${e.kind})`).join(' '));
if (events.length < 1) fail('events.json kosong — VLM tidak mendeteksi momen');

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
console.log('final.mp4 durasi:', outDur.toFixed(1), 's (input', videoDur.toFixed(1), 's)');
if (Math.abs(outDur - videoDur) > 2) fail('durasi output tidak wajar');

for (const id of seeded) removeSfx(id);
fs.rmSync(fixturesDir, { recursive: true, force: true });
console.log('cleanup:', seeded.length, 'fixture SFX dihapus');

console.log('\n===== E2E LULUS ✓ =====');
await new Promise((r) => srv.close(r));
void getJobEvents;
process.exit(0);
