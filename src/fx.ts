import type { Beat } from './manifest.js';
import { chatJson } from './openai.js';
import {
  FX_LONG_VIDEO_SEC,
  type FxCue,
  fxCatalogBrief,
  validateFx,
} from './fx-catalog.js';

/**
 * Planner FX: pilih efek visual (vfx) + audio (afx) per beat dari katalog.
 * AI hanya MEMILIH + MENENTUKAN WAKTU — tidak menggambar/mensintesis apa pun.
 * Aturan keras divalidasi ulang oleh validateFx (klamp, tumpang tindih, batas).
 */
export async function planFx(opts: {
  beats: Beat[];
  durationSec: number;
  userPrompt: string;
  log: (m: string) => void;
}): Promise<FxCue[]> {
  const { beats, durationSec, userPrompt, log } = opts;
  if (beats.length === 0) {
    log('fx: tidak ada beat → 0 efek');
    return [];
  }

  const beatsBrief = beats
    .map((b, i) =>
      [
        `Beat ${i}: t=${b.t}s..${b.end}s type=${b.type}`,
        `  konteks: ${b.context}`,
        `  catatan: ${b.notes}`,
      ].join('\n')
    )
    .join('\n');

  const longVideo = durationSec > FX_LONG_VIDEO_SEC;

  const sys = [
    'Kamu motion/sound designer untuk video pendek. Pilih EFEK dari KATALOG berdasarkan beat video.',
    'Aturan keras:',
    '1. Maksimal 1 vfx DAN 1 afx per beat. Jangan beri efek di beat biasa — lebih baik kosong daripada berantakan.',
    '2. vfx hanya untuk momen kuat (punchline, reveal, transisi keras, puncak tegang).',
    '3. afx (echo/reverb) HANYA untuk beat type=dialogue (suara manusia/dialog) atau saat konteks menyebut suara bergema.',
    '4. start = detik kejutan yang akurat (di dalam rentang beat); end mengikuti durasi default/diizinkan efek.',
    '5. intensity 0.3..1 (0.7 = kuat standar; 0.4 halus; 1 maksimal).',
    `6. Maksimal ${longVideo ? '6 vfx dan 3 afx' : '10 vfx dan 5 afx'} total untuk seluruh video${longVideo ? ' (video panjang → lebih hemat)' : ''}.`,
    '7. Efek tidak boleh saling tumpang-tindih dalam jenis yang sama.',
    '8. reason: 1 kalimat bahasa Indonesia (audit-able).',
    '',
    'KATALOG EFEK:',
    fxCatalogBrief(),
    '',
    userPrompt ? `Panduan user: ${userPrompt}` : '',
    '',
    'Balas HANYA JSON:',
    '{"fx":[{"effect":"<nama>","start":<detik>,"end":<detik>,"intensity":<0.1-1>,"text":"<opsional>","color":"<opsional hex>","reason":"..."}]}',
    'Balas {"fx":[]} kalau tidak ada efek yang layak.',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chatJson<{ fx?: unknown[] }>(
    [
      { role: 'system', content: sys },
      { role: 'user', content: `BEAT VIDEO (durasi ${durationSec.toFixed(1)}s):\n${beatsBrief}` },
    ],
    { timeoutMs: 180_000 }
  );

  const fx = validateFx(raw?.fx, durationSec);
  log(`fx: ${fx.filter((f) => f.kind === 'vfx').length} vfx + ${fx.filter((f) => f.kind === 'afx').length} afx final`);
  return fx;
}
