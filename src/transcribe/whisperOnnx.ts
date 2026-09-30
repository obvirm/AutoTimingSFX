import { getSettings } from '../config.js';
import { readAudioMono16k } from '../ffmpeg.js';
import type { Word } from './audiocpp.js';

let transcriberPromise: Promise<any> | null = null;

async function getTranscriber(): Promise<any> {
  if (transcriberPromise) return transcriberPromise;
  const s = getSettings();
  transcriberPromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    console.log(`[whisper-onnx] memuat model ${s.WHISPER_ONNX_MODEL} (dtype=${s.WHISPER_ONNX_DTYPE})...`);
    const t0 = Date.now();
    const pipe = await pipeline('automatic-speech-recognition', s.WHISPER_ONNX_MODEL, {
      dtype: s.WHISPER_ONNX_DTYPE as any,
      device: 'cpu',
    });
    console.log(`[whisper-onnx] model siap dalam ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return pipe;
  })();
  try {
    return await transcriberPromise;
  } catch (e) {
    transcriberPromise = null;
    throw e;
  }
}

/**
 * Mode 1 (default): Whisper ONNX lokal via @huggingface/transformers
 * (model ladder sama dengan tscaps: onnx-community/whisper-*_timestamped,
 * default medium) → word-level timestamps.
 */
export async function transcribeOnnx(wavPath: string, language?: string): Promise<Word[]> {
  const pcm = await readAudioMono16k(wavPath);
  const pipe = await getTranscriber();
  const opts: Record<string, unknown> = {
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  // transformers.js TIDAK auto-detect bahasa (default 'en') → pakai settings
  const lang = language || getSettings().WHISPER_LANGUAGE;
  if (lang) opts.language = lang;
  const out = await pipe(pcm, opts);
  const chunks = (out?.chunks ?? []) as { text: string; timestamp: [number, number | null] }[];
  const words: Word[] = [];
  for (const c of chunks) {
    const t = (c.text ?? '').trim();
    if (!t) continue;
    const start = c.timestamp?.[0];
    if (start === null || start === undefined || !Number.isFinite(start)) continue;
    const end = c.timestamp?.[1];
    words.push({ w: t, start, end: end !== null && end !== undefined && Number.isFinite(end) ? end : start + 0.25 });
  }
  return words;
}
