import { getSettings } from './config.js';
import { getSfx } from './db.js';
import type { Beat } from './manifest.js';
import { chatJson } from './openai.js';
import { allSfxWithText, searchSfx } from './sfx.js';
import type { Word } from './transcribe/audiocpp.js';
import { clamp } from './util.js';

export type CueType = 'impact' | 'voice' | 'ambience' | 'stinger';

export interface Cue {
  id: string;
  start: number; // detik penempatan file (sudah dikoreksi onset + lead)
  sfxId: number;
  sfxFile: string;
  gain: number; // linear 0..1
  leadMs: number;
  anchorT: number; // detik momen rujukan
  type: CueType;
  reason: string;
}

interface RawCue {
  beatT: number;
  sfxId: number;
  anchorT?: number;
  leadMs?: number;
  gainDb?: number;
  type?: CueType;
  reason?: string;
}

function wordsNear(words: Word[], t: number, span = 2.5): Word[] {
  return words.filter((w) => w.start >= t - span && w.start <= t + span).slice(0, 24);
}

/**
 * Picker RAG: untuk tiap beat → kandidat SFX (embedding/semantik) → LLM memilih
 * + menentukan anchor & lead → validasi kepadatan → cue list final.
 */
export async function pickSfx(opts: {
  beats: Beat[];
  words: Word[];
  userPrompt: string;
  durationSec: number;
  log: (m: string) => void;
}): Promise<Cue[]> {
  const { beats, words, userPrompt, durationSec, log } = opts;
  const s = getSettings();
  const minGap = Number(s.SFX_MIN_GAP_SEC || 5);
  const maxPerBeat = Number(s.SFX_MAX_PER_BEAT || 1);
  const defaultLead = Number(s.RENDER_LEAD_MS || -120);

  const catalog = allSfxWithText();
  if (catalog.length === 0 || beats.length === 0) {
    log('picker: library kosong atau tidak ada beat → 0 cue');
    return [];
  }

  // Kandidat per beat: union hasil search semantik (fallback: semua)
  const candIds = new Set<number>();
  for (const b of beats) {
    const q = `${b.context} ${b.notes}`.trim() || 'sound effect';
    const hits = await searchSfx(q, 15);
    for (const h of hits) if (h.score > 0 || hits.length < 15) candIds.add(h.sfx.id);
    if (candIds.size >= 80) break;
  }
  let candidates = catalog.filter((c) => candIds.has(c.id));
  if (candidates.length === 0) candidates = catalog;

  const catalogBrief = candidates
    .map((c) => `- id=${c.id}: ${c.text} (durasi ${(c.duration_ms / 1000).toFixed(1)}s)`)
    .join('\n');

  const beatsBrief = beats
    .map((b, i) => {
      const near = wordsNear(words, (b.t + b.end) / 2)
        .map((w) => `"${w.w}"@${w.start.toFixed(2)}s`)
        .join(' ');
      return [
        `Beat ${i}: t=${b.t}s..${b.end}s type=${b.type}`,
        `  konteks: ${b.context}`,
        `  catatan: ${b.notes}`,
        near ? `  kata terdekat: ${near}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const sys = [
    'Kamu pemilih sound effect (SFX) untuk video editor. Pilih SFX DARI KATALOG berdasarkan deskripsi buatan manusia.',
    'Aturan keras:',
    `1. Maksimal ${maxPerBeat} SFX per beat, dan jarak minimal antar cue ${minGap} detik.`,
    '2. Jangan kasih SFX di beat yang biasa saja — lebih baik kosong daripada berantakan.',
    '3. type: "impact" = suara kejutan/pukulan/whoosh (leadMs default ' + defaultLead + ' — mulai SEBELUM momen);',
    '   "voice" = SFX berbunyi manusia/hewan (mis. "aduh tunggu") → leadMs 0, harus jatuh tepat di anchor;',
    '   "stinger" = musik/jingle pendek penekan → leadMs -50;',
    '   "ambience" = suasana latar → leadMs 0, mulai di awal beat, gain rendah (-18 s/d -30 dB).',
    '4. anchorT = detik MASEWAH momen (boleh di dalam rentang beat, snap ke kata terdekat bila ada),',
    '   leadMs = kapan SUARA MULAI relatif terhadap anchor (negatif = lebih awal).',
    '5. gainDb umumnya -18..0 dB (dialogue padat → lebih rendah).',
    '6. reason: 1 kalimat bahasa Indonesia, kenapa SFX ini cocok (audit-able).',
    '7. Hanya pakai sfxId yang ada di katalog.',
    '',
    userPrompt ? `Panduan user: ${userPrompt}` : '',
    '',
    'Balas HANYA JSON:',
    '{"cues":[{"beatT":<detik>,"sfxId":<id>,"anchorT":<detik>,"leadMs":<ms>,"gainDb":<dB>,"type":"impact|voice|stinger|ambience","reason":"..."}]}',
    'Balas {"cues":[]} kalau tidak ada yang layak.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chatJson<{ cues: RawCue[] }>(
    [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `KATALOG SFX (deskripsi ditulis manusia):\n${catalogBrief}\n\nBEAT VIDEO:\n${beatsBrief}\n\nDurasi video: ${durationSec.toFixed(1)}s`,
      },
    ],
    { timeoutMs: 240_000 }
  );

  const rawCues = Array.isArray(raw?.cues) ? raw.cues : [];
  log(`picker: ${rawCues.length} kandidat cue dari LLM`);

  // Validasi + hitung penempatan final
  const cues: Cue[] = [];
  let i = 0;
  for (const rc of rawCues) {
    const sfx = getSfx(Number(rc.sfxId));
    if (!sfx) continue;
    const type: CueType = (['impact', 'voice', 'ambience', 'stinger'] as const).includes(rc.type as CueType)
      ? (rc.type as CueType)
      : 'impact';
    let anchor = Number(rc.anchorT ?? rc.beatT);
    if (!Number.isFinite(anchor)) continue;
    anchor = clamp(anchor, 0, durationSec);
    const leadMs = clamp(Number(rc.leadMs ?? defaultLead), -500, 200);
    const gainDb = clamp(Number(rc.gainDb ?? -12), -40, 0);
    const gain = Math.pow(10, gainDb / 20);
    // penempatan: onset suara harus tiba di anchor + lead
    const onsetSec = type === 'ambience' ? 0 : sfx.onset_ms / 1000;
    let start = anchor + leadMs / 1000 - onsetSec;
    if (start < 0) start = 0;
    if (start > durationSec - 0.2) continue;
    cues.push({
      id: `c${++i}`,
      start: Math.round(start * 1000) / 1000,
      sfxId: sfx.id,
      sfxFile: sfx.file_path,
      gain: Math.round(gain * 1000) / 1000,
      leadMs,
      anchorT: Math.round(anchor * 1000) / 1000,
      type,
      reason: String(rc.reason ?? '').slice(0, 300),
    });
  }

  // Kepadaan: jaga jarak minGap (ambience dikecualikan)
  cues.sort((a, b) => a.start - b.start);
  const filtered: Cue[] = [];
  for (const c of cues) {
    const prevImpacts = filtered.filter((f) => f.type !== 'ambience');
    const last = prevImpacts[prevImpacts.length - 1];
    if (last && c.type !== 'ambience' && c.start - last.start < minGap) {
      log(`picker: buang cue @${c.start}s (${c.reason}) — bentrok jarak < ${minGap}s`);
      continue;
    }
    if (c.type === 'ambience' && filtered.some((f) => f.type === 'ambience' && Math.abs(f.start - c.start) < 5)) {
      continue;
    }
    filtered.push(c);
  }
  log(`picker: ${filtered.length} cue final`);
  return filtered;
}
