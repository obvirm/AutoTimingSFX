import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from './config.js';

export interface SfxRow {
  id: number;
  filename: string;
  file_path: string;
  description: string;
  tags: string;
  category: string;
  duration_ms: number;
  lufs: number;
  onset_ms: number;
  peak_db: number;
  embed_model: string;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  status: string;
  stage: string;
  engine: string;
  video_name: string;
  video_path: string;
  prompt: string;
  options: string;
  data: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  ts: string;
  level: string;
  message: string;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sfx (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      lufs REAL NOT NULL DEFAULT -23,
      onset_ms INTEGER NOT NULL DEFAULT 0,
      peak_db REAL NOT NULL DEFAULT -20,
      embed_model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL DEFAULT 'onnx',
      video_name TEXT NOT NULL DEFAULT '',
      video_path TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      options TEXT NOT NULL DEFAULT '{}',
      data TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      vec BLOB NOT NULL,
      PRIMARY KEY (kind, ref_id, model)
    );
  `);
  return db;
}

/* ---------- SFX ---------- */

export function listSfx(): SfxRow[] {
  return getDb().prepare('SELECT * FROM sfx ORDER BY id DESC').all() as unknown as SfxRow[];
}

export function getSfx(id: number): SfxRow | undefined {
  return getDb().prepare('SELECT * FROM sfx WHERE id = ?').get(id) as SfxRow | undefined;
}

export function insertSfx(r: {
  filename: string;
  file_path: string;
  duration_ms: number;
  lufs: number;
  onset_ms: number;
  peak_db: number;
}): number {
  const res = getDb()
    .prepare(
      'INSERT INTO sfx (filename, file_path, duration_ms, lufs, onset_ms, peak_db) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(r.filename, r.file_path, r.duration_ms, r.lufs, r.onset_ms, r.peak_db);
  return Number(res.lastInsertRowid);
}

export function updateSfx(
  id: number,
  patch: { description?: string; tags?: string; category?: string }
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.description !== undefined) {
    sets.push('description = ?');
    vals.push(patch.description);
  }
  if (patch.tags !== undefined) {
    sets.push('tags = ?');
    vals.push(patch.tags);
  }
  if (patch.category !== undefined) {
    sets.push('category = ?');
    vals.push(patch.category);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb()
    .prepare(`UPDATE sfx SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(vals as never[]));
}

export function deleteSfx(id: number): void {
  getDb().prepare('DELETE FROM sfx WHERE id = ?').run(id);
  getDb().prepare("DELETE FROM embeddings WHERE kind = 'sfx' AND ref_id = ?").run(id);
}

/* ---------- Embeddings ---------- */

export function saveEmbedding(kind: string, refId: number, model: string, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO embeddings (kind, ref_id, model, vec) VALUES (?, ?, ?, ?)'
    )
    .run(kind, refId, model, buf);
}

export function loadEmbeddings(kind: string): { refId: number; model: string; vec: Float32Array }[] {
  const rows = getDb()
    .prepare('SELECT ref_id, model, vec FROM embeddings WHERE kind = ?')
    .all(kind) as unknown as { ref_id: number; model: string; vec: Uint8Array }[];
  return rows.map((r) => ({
    refId: r.ref_id,
    model: r.model,
    vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4),
  }));
}

/* ---------- Jobs ---------- */

export function createJob(j: {
  id: string;
  engine: string;
  video_name: string;
  video_path: string;
  prompt: string;
  options: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO jobs (id, status, stage, engine, video_name, video_path, prompt, options)
       VALUES (?, 'queued', 'queued', ?, ?, ?, ?, ?)`
    )
    .run(j.id, j.engine, j.video_name, j.video_path, j.prompt, j.options);
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function listJobs(): JobRow[] {
  return getDb().prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC').all() as unknown as JobRow[];
}

export function updateJob(id: string, patch: Partial<JobRow>): void {
  const allowed = ['status', 'stage', 'error', 'data'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (patch[k as keyof JobRow] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k as keyof JobRow]);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb()
    .prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(vals as never[]));
}

export function saveJobData(id: string, patch: Record<string, unknown>): void {
  const job = getJob(id);
  if (!job) return;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(job.data);
  } catch {
    /* reset */
  }
  Object.assign(data, patch);
  updateJob(id, { data: JSON.stringify(data) });
}

export function addJobEvent(jobId: string, message: string, level = 'info'): void {
  getDb()
    .prepare('INSERT INTO job_events (job_id, level, message) VALUES (?, ?, ?)')
    .run(jobId, level, message);
}

export function getJobEvents(jobId: string): JobEvent[] {
  return getDb()
    .prepare('SELECT ts, level, message FROM job_events WHERE job_id = ? ORDER BY id')
    .all(jobId) as unknown as JobEvent[];
}
