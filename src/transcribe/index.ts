import { getSettings } from '../config.js';
import type { Word } from './audiocpp.js';

export type Engine = 'onnx' | 'audiocpp';

export const ENGINE_LABEL: Record<Engine, string> = {
  onnx: 'Whisper ONNX (lokal, default)',
  audiocpp: 'audio.cpp (localhost:8080)',
};

/** Transkripsi dengan engine pilihan → word-level timestamps. */
export async function transcribe(engine: Engine, wavPath: string, language?: string): Promise<Word[]> {
  const lang = language || getSettings().WHISPER_LANGUAGE || undefined;
  if (engine === 'audiocpp') {
    const { transcribeAudioCpp } = await import('./audiocpp.js');
    return transcribeAudioCpp(wavPath, lang);
  }
  const { transcribeOnnx } = await import('./whisperOnnx.js');
  return transcribeOnnx(wavPath, lang);
}
