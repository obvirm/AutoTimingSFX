import fs from 'node:fs';
import { getSettings } from '../config.js';

export interface Word {
  w: string;
  start: number;
  end: number;
}

/**
 * Mode 2: audio.cpp (github.com/0xShug0/audio.cpp) di AUDIOCPP_SERVER (default :8080).
 * Endpoint OpenAI-compatible /v1/audio/transcriptions + timestamp_granularities[]=word
 * → word-level + forced alignment.
 */
export async function transcribeAudioCpp(wavPath: string, language?: string): Promise<Word[]> {
  const s = getSettings();
  const form = new FormData();
  const buf = fs.readFileSync(wavPath);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', s.AUDIOCPP_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (language) form.append('language', language);

  const res = await fetch(`${s.AUDIOCPP_SERVER.replace(/\/$/, '')}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`audio.cpp HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j: any = await res.json();
  return normalizeWords(j);
}

/** Normalisasi berbagai bentuk respons ASR menjadi word[]. */
export function normalizeWords(j: any): Word[] {
  const out: Word[] = [];
  const push = (w: string, start: number, end: number) => {
    const t = w.trim();
    if (!t || !Number.isFinite(start)) return;
    out.push({ w: t, start, end: Number.isFinite(end) ? end : start });
  };

  if (Array.isArray(j?.words)) {
    for (const x of j.words) push(x.word ?? x.text ?? '', Number(x.start), Number(x.end));
  }
  if (out.length === 0 && Array.isArray(j?.segments)) {
    for (const seg of j.segments) {
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        for (const x of seg.words) push(x.word ?? x.text ?? '', Number(x.start), Number(x.end));
      } else {
        // fallback: sebar teks segmen proporsional
        const text = String(seg.text ?? '').trim();
        if (!text) continue;
        const parts = text.split(/\s+/);
        const start = Number(seg.start);
        const end = Number(seg.end);
        const step = (end - start) / Math.max(parts.length, 1);
        parts.forEach((p, i) => push(p, start + i * step, start + (i + 1) * step));
      }
    }
  }
  if (out.length === 0 && Array.isArray(j?.transcription)) {
    // gaya whisper.cpp: timestamps.from/to dalam satuan 10ms
    for (const x of j.transcription) {
      const from = Number(x?.timestamps?.from ?? 0) / 100;
      const to = Number(x?.timestamps?.to ?? 0) / 100;
      const parts = String(x?.text ?? '').trim().split(/\s+/);
      const step = (to - from) / Math.max(parts.length, 1);
      parts.forEach((p, i) => push(p, from + i * step, from + (i + 1) * step));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
