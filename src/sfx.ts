import fs from 'node:fs';
import path from 'node:path';
import { SFX_DIR } from './config.js';
import {
  deleteSfx,
  getSfx,
  insertSfx,
  listSfx,
  loadEmbeddings,
  saveEmbedding,
  updateSfx,
  type SfxRow,
} from './db.js';
import { analyzeSfx } from './ffmpeg.js';
import { activeEmbeddingModel, embed, tokenScore } from './embedding.js';
import { cosine } from './util.js';

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()\[\]]+/g, '_');
  return base.toLowerCase().endsWith('.mp3') || base.toLowerCase().endsWith('.wav') || base.toLowerCase().endsWith('.ogg') || base.toLowerCase().endsWith('.flac')
    ? base
    : `${base}.mp3`;
}

/** Import file SFX (buffer dari upload) → copy ke data/sfx/ + analisis + insert DB. */
export async function importSfx(name: string, buf: Buffer): Promise<SfxRow> {
  let filename = safeName(name);
  const dest = path.join(SFX_DIR, filename);
  if (fs.existsSync(dest)) {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    filename = `${stem}_${Date.now()}${ext}`;
  }
  const finalPath = path.join(SFX_DIR, filename);
  fs.writeFileSync(finalPath, buf);
  let a = { duration_ms: 0, lufs: -23, onset_ms: 0, peak_db: -20 };
  try {
    a = await analyzeSfx(finalPath);
  } catch (e) {
    // file rusak → hapus & lempar
    fs.unlinkSync(finalPath);
    throw new Error(`Gagal menganalisis SFX: ${(e as Error).message}`);
  }
  const id = insertSfx({ filename, file_path: finalPath, ...a });
  const row = getSfx(id)!;
  return row;
}

export async function saveSfxDescription(
  id: number,
  patch: { description?: string; tags?: string[]; category?: string }
): Promise<SfxRow | null> {
  const row = getSfx(id);
  if (!row) return null;
  updateSfx(id, {
    description: patch.description,
    tags: patch.tags ? JSON.stringify(patch.tags) : undefined,
    category: patch.category,
  });
  const after = getSfx(id)!;
  const text = searchText(after);
  if (text) {
    const vecs = await embed([text]);
    if (vecs && vecs[0]) saveEmbedding('sfx', id, activeEmbeddingModel(), vecs[0]);
  }
  return after;
}

export function removeSfx(id: number): void {
  const row = getSfx(id);
  if (!row) return;
  deleteSfx(id);
  try {
    if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  } catch {
    /* biarkan */
  }
}

function searchText(r: SfxRow): string {
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags);
  } catch {
    /* ignore */
  }
  return [r.filename, r.category, r.description, tags.join(' ')].filter(Boolean).join(' | ');
}

export interface SearchHit {
  sfx: SfxRow;
  score: number;
}

/** Pencarian semantik (embedding cosine) dengan fallback substring. */
export async function searchSfx(query: string, k = 20): Promise<SearchHit[]> {
  const all = listSfx().filter((r) => r.description.trim().length > 0 || r.tags !== '[]');
  if (all.length === 0) return [];
  const qVecs = await embed([query]);
  if (qVecs && qVecs[0]) {
    const q = qVecs[0];
    const stored = new Map<number, Float32Array>();
    for (const e of loadEmbeddings('sfx')) stored.set(e.refId, e.vec);
    const hits: SearchHit[] = [];
    for (const r of all) {
      const v = stored.get(r.id);
      if (v && v.length === q.length) hits.push({ sfx: r, score: cosine(q, v) });
      else hits.push({ sfx: r, score: -1 });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
  // fallback: skor berbasis token
  const scored = all
    .map((r) => ({ sfx: r, score: tokenScore(query, searchText(r)) }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function allSfxWithText(): { id: number; text: string; duration_ms: number; onset_ms: number }[] {
  return listSfx()
    .filter((r) => r.description.trim().length > 0)
    .map((r) => ({ id: r.id, text: searchText(r), duration_ms: r.duration_ms, onset_ms: r.onset_ms }));
}
