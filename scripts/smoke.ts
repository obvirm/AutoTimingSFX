/* Smoke test end-to-end in-process: server + SFX import + deskripsi + cari + job kosong. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SFX_DIR, ensureDirs } from '../src/config.js';
import { getDb, listSfx, createJob, getJob } from '../src/db.js';
import { importSfx, saveSfxDescription, searchSfx, removeSfx } from '../src/sfx.js';
import { createApp } from '../src/server.js';
import { newId } from '../src/util.js';

ensureDirs();
getDb();

// 1. generate 2 SFX sintetis (bukan bagian produk — hanya fixture test)
const tmp = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const fixture1 = path.join(tmp, 'fixture_boing.wav');
const fixture2 = path.join(tmp, 'fixture_aduh.wav');
execFileSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.8', '-af', 'aformat=sample_rates=16000', fixture1]);
execFileSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=1.2', '-af', 'aformat=sample_rates=16000', fixture2]);

// 2. import ke library
const a = await importSfx('boing_karet.wav', fs.readFileSync(fixture1));
console.log('import 1 OK:', a.id, a.filename, a.duration_ms + 'ms', 'onset=' + a.onset_ms + 'ms', 'lufs=' + a.lufs);
const b = await importSfx('aduh_tunggu.wav', fs.readFileSync(fixture2));
console.log('import 2 OK:', b.id, b.filename, b.duration_ms + 'ms', 'onset=' + b.onset_ms + 'ms');
if (a.onset_ms < 0 || a.duration_ms <= 0) throw new Error('analisis gagal');

// 3. tulis deskripsi + embed
const saved = await saveSfxDescription(a.id, {
  description: 'Suara boing karet elastis, komedi, pantulan lucu',
  tags: ['komedi', 'boing'],
  category: 'komedi',
});
console.log('deskripsi OK:', saved?.description);
await saveSfxDescription(b.id, {
  description: 'Suara orang bilang aduh tunggu, panik, vokal komedi',
  tags: ['vokal', 'panik'],
  category: 'vokal',
});

// 4. search (embedding atau fallback)
const hits = await searchSfx('suara karet lucu komedi', 5);
console.log('search OK:', hits.map((h) => `${h.sfx.id}:${h.score.toFixed(3)}`).join(', '));
if (hits.length === 0) throw new Error('search kosong');
if (hits[0].sfx.id !== a.id) throw new Error('SFX teratas salah harapnya boing_karet');

// 5. jalankan server sebentar & hit API
const app = createApp();
const srv = await new Promise<any>((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const port = (srv.address() as any).port;
const base = `http://localhost:${port}`;

const j1 = await (await fetch(`${base}/api/sfx`)).json();
console.log('GET /api/sfx OK:', j1.length, 'rows');
if (!j1.some((r: any) => r.id === a.id) || !j1.some((r: any) => r.id === b.id)) throw new Error('import tidak muncul di list');

const j2 = await (await fetch(`${base}/api/sfx/search?q=karet`)).json();
console.log('GET /api/sfx/search OK:', j2.length, 'hits');

// upload video dummy → job invalid path ditolak dengan benar
const up = await fetch(`${base}/api/upload?name=tone.mp4`, {
  method: 'POST',
  body: fs.readFileSync(fixture1),
});
const upJ: any = await up.json();
console.log('upload OK:', upJ.videoPath);
if (!fs.existsSync(upJ.videoPath)) throw new Error('upload tidak tersimpan');

const run = await fetch(`${base}/api/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoPath: upJ.videoPath, engine: 'audiocpp' }),
});
const runJ: any = await run.json();
console.log('run OK:', runJ.jobId);
const job = getJob(runJ.jobId);
console.log('job row:', job?.status, job?.stage);

// audio.cpp tidak jalan → job harus gagal rapi di stage transcribe (error handling teruji)
await new Promise((r) => setTimeout(r, 8000));
const after = getJob(runJ.jobId);
console.log('job setelah 3s:', after?.status, after?.stage, after?.error.slice(0, 120));

const jobsList = await (await fetch(`${base}/api/jobs`)).json();
console.log('GET /api/jobs OK:', jobsList.length);

const set = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ SFX_MIN_GAP_SEC: '5' }) });
console.log('settings PUT OK:', (await set.json()).ok);

await new Promise((r) => srv.close(r));

// bersihkan fixture supaya library user tidak tercemar file test
removeSfx(a.id);
removeSfx(b.id);
try { fs.unlinkSync(upJ.videoPath); } catch { /* ignore */ }
for (const f of [fixture1, fixture2]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
console.log('cleanup OK, sisa rows:', listSfx().length);
console.log('SMOKE TEST LULUS ✓');
process.exit(0);
