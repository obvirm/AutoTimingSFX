import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SFX_DIR = path.join(DATA_DIR, 'sfx');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const JOBS_DIR = path.join(DATA_DIR, 'output', 'jobs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const DB_PATH = path.join(DATA_DIR, 'autosfx.db');

export function ensureDirs(): void {
  for (const d of [DATA_DIR, SFX_DIR, UPLOAD_DIR, JOBS_DIR, TMP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export interface Settings {
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
  MODEL_NAME: string;
  VLM_MODEL: string;
  /** Model cadangan dipakai berurutan kalau MODEL_NAME gagal (upstream error). */
  LLM_FALLBACK_MODELS: string;
  EMBEDDING_MODEL: string;

  AUDIOCPP_SERVER: string;
  AUDIOCPP_MODEL: string;
  WHISPER_ONNX_MODEL: string;
  WHISPER_ONNX_DTYPE: string;
  WHISPER_LANGUAGE: string;
  SFX_MIN_GAP_SEC: string;
  SFX_MAX_PER_BEAT: string;
  RENDER_LEAD_MS: string;
}

export const SETTING_KEYS: (keyof Settings)[] = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'MODEL_NAME',
  'VLM_MODEL',
  'LLM_FALLBACK_MODELS',
  'EMBEDDING_MODEL',
  'AUDIOCPP_SERVER',
  'AUDIOCPP_MODEL',
  'WHISPER_ONNX_MODEL',
  'WHISPER_ONNX_DTYPE',
  'WHISPER_LANGUAGE',
  'SFX_MIN_GAP_SEC',
  'SFX_MAX_PER_BEAT',
  'RENDER_LEAD_MS',
];

const DEFAULTS: Settings = {
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_API_KEY: '',
  MODEL_NAME: 'gpt-4o-mini',
  VLM_MODEL: 'gpt-4o-mini',
  LLM_FALLBACK_MODELS: 'space-bunny-alpha',
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  AUDIOCPP_SERVER: 'http://localhost:8080',
  AUDIOCPP_MODEL: 'whisper-large-v3',
  WHISPER_ONNX_MODEL: 'onnx-community/whisper-medium_timestamped',
  WHISPER_ONNX_DTYPE: 'q8',
  WHISPER_LANGUAGE: 'id',
  SFX_MIN_GAP_SEC: '5',
  SFX_MAX_PER_BEAT: '1',
  RENDER_LEAD_MS: '-120',
};

/** Settings = default < process.env < data/settings.json (override UI) */
export function getSettings(): Settings {
  const out: Settings = { ...DEFAULTS };
  for (const k of SETTING_KEYS) {
    const envVal = process.env[k];
    if (envVal !== undefined && envVal !== '') out[k] = envVal;
  }
  try {
    const p = path.join(DATA_DIR, 'settings.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Settings>;
      for (const k of SETTING_KEYS) {
        if (typeof j[k] === 'string' && j[k] !== '') out[k] = j[k] as string;
      }
    }
  } catch {
    /* settings.json rusak → abaikan */
  }
  return out;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const p = path.join(DATA_DIR, 'settings.json');
  let cur: Record<string, string> = {};
  try {
    if (fs.existsSync(p)) cur = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    /* reset */
  }
  for (const k of SETTING_KEYS) {
    if (typeof patch[k] === 'string') cur[k] = patch[k] as string;
  }
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
  return getSettings();
}
