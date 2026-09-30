import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, SETTING_KEYS, getSettings, saveSettings, UPLOAD_DIR, SFX_DIR } from './config.js';
import {
  addJobEvent,
  createJob,
  getJob,
  getJobEvents,
  getSfx,
  listJobs,
  listSfx,
} from './db.js';
import { jobDir, requestCancel, rerenderJob, runJob } from './pipeline.js';
import type { Cue } from './picker.js';
import { importSfx, removeSfx, saveSfxDescription, searchSfx } from './sfx.js';
import { newId } from './util.js';

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '40mb' }));

  /* ---------- Settings ---------- */
  app.get('/api/settings', (_req, res) => {
    const s = getSettings();
    const safe: Record<string, string> = {};
    for (const k of SETTING_KEYS) {
      safe[k] = k === 'OPENAI_API_KEY' ? (s[k] ? '••••' + s[k].slice(-4) : '') : s[k];
    }
    res.json(safe);
  });
  app.put('/api/settings', (req, res) => {
    const patch: Record<string, string> = {};
    for (const k of SETTING_KEYS) {
      const v = req.body?.[k];
      if (typeof v === 'string' && v !== '' && !v.startsWith('••••')) patch[k] = v;
    }
    saveSettings(patch as never);
    res.json({ ok: true });
  });

  /* ---------- SFX library ---------- */
  app.get('/api/sfx', (_req, res) => res.json(listSfx()));
  app.get('/api/sfx/search', async (req, res) => {
    const q = String(req.query.q ?? '');
    const hits = await searchSfx(q, 30);
    res.json(hits);
  });
  app.post('/api/sfx/import', async (req, res) => {
    try {
      const name = String(req.query.name ?? 'sfx.mp3');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const row = await importSfx(name, Buffer.concat(chunks));
      res.json(row);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.get('/api/sfx/:id/file', (req, res) => {
    const row = getSfx(Number(req.params.id));
    if (!row || !fs.existsSync(row.file_path)) return res.status(404).end();
    res.sendFile(row.file_path);
  });
  app.put('/api/sfx/:id', async (req, res) => {
    const row = await saveSfxDescription(Number(req.params.id), {
      description: req.body?.description,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : undefined,
      category: typeof req.body?.category === 'string' ? req.body.category : undefined,
    });
    if (!row) return res.status(404).json({ error: 'tidak ditemukan' });
    res.json(row);
  });
  app.delete('/api/sfx/:id', (req, res) => {
    removeSfx(Number(req.params.id));
    res.json({ ok: true });
  });

  /* ---------- Video upload (raw body, pola movie2short) ---------- */
  app.post('/api/upload', async (req, res) => {
    try {
      const name = path.basename(String(req.query.name ?? 'video.mp4'));
      const dest = path.join(UPLOAD_DIR, `${Date.now()}_${name}`);
      const ws = fs.createWriteStream(dest);
      await new Promise<void>((resolve, reject) => {
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      res.json({ videoPath: dest, name });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /* ---------- Jobs ---------- */
  app.post('/api/run', (req, res) => {
    const { videoPath, prompt = '', engine = 'onnx', options = {} } = req.body ?? {};
    if (!videoPath || !fs.existsSync(videoPath)) {
      return res.status(400).json({ error: 'videoPath tidak valid — upload dulu via /api/upload' });
    }
    const id = newId();
    createJob({
      id,
      engine: engine === 'audiocpp' ? 'audiocpp' : 'onnx',
      video_name: path.basename(videoPath),
      video_path: videoPath,
      prompt: String(prompt),
      options: JSON.stringify({ engine, ...options }),
    });
    addJobEvent(id, 'job dibuat');
    void runJob(id);
    res.json({ jobId: id });
  });

  app.get('/api/jobs', (_req, res) => {
    const rows = listJobs().map((j) => ({
      id: j.id,
      status: j.status,
      stage: j.stage,
      engine: j.engine,
      video_name: j.video_name,
      prompt: j.prompt,
      created_at: j.created_at,
      updated_at: j.updated_at,
      error: j.error,
    }));
    res.json(rows);
  });

  app.get('/api/jobs/:id', (req, res) => {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'tidak ditemukan' });
    let data: unknown = {};
    try {
      data = JSON.parse(j.data);
    } catch {
      /* ignore */
    }
    res.json({
      id: j.id,
      status: j.status,
      stage: j.stage,
      engine: j.engine,
      video_name: j.video_name,
      video_path: j.video_path,
      prompt: j.prompt,
      error: j.error,
      created_at: j.created_at,
      updated_at: j.updated_at,
      data,
      events: getJobEvents(j.id),
    });
  });

  app.get('/api/jobs/:id/log', (req, res) => res.json(getJobEvents(req.params.id)));

  app.post('/api/jobs/:id/cancel', (req, res) => {
    requestCancel(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/jobs/:id/rerender', (req, res) => {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'tidak ditemukan' });
    const cues = (req.body?.cues ?? []) as Cue[];
    if (!Array.isArray(cues)) return res.status(400).json({ error: 'cues wajib array' });
    void rerenderJob(req.params.id, cues);
    res.json({ ok: true });
  });

  /* ---------- Artifacts (final.mp4, cue_list.json, dsb) ---------- */
  app.get('/api/jobs/:id/artifact/:name', (req, res) => {
    try {
      const dir = jobDir(req.params.id);
      const file = path.join(dir, path.basename(req.params.name));
      if (!fs.existsSync(file)) return res.status(404).end();
      res.sendFile(file);
    } catch {
      res.status(400).end();
    }
  });

  /* ---------- Static: studio build + SPA fallback ---------- */
  const dist = path.join(ROOT, 'studio', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  void DATA_DIR;
  void SFX_DIR;
  void UPLOAD_DIR;
  return app;
}
