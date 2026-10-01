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

export interface SearchHit {
  sfx: SfxRow;
  score: number;
}

export interface JobEvent {
  ts: string;
  level: string;
  message: string;
}

export type CueType = 'impact' | 'voice' | 'ambience' | 'stinger';

export interface Cue {
  id: string;
  start: number;
  sfxId: number;
  sfxFile: string;
  gain: number;
  leadMs: number;
  anchorT: number;
  type: CueType;
  reason: string;
}

export interface FxCue {
  id: string;
  kind: 'vfx' | 'afx';
  effect: string;
  start: number;
  end: number;
  intensity: number;
  text?: string;
  color?: string;
  reason: string;
}

export interface JobSummary {
  id: string;
  status: string;
  stage: string;
  video_name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
  error: string;
}

export interface JobDetail extends JobSummary {
  video_path: string;
  data: { cueCount?: number; [k: string]: unknown };
  events: JobEvent[];
}

export interface SettingsMap {
  [k: string]: string;
}

export interface Beat {
  t: number;
  type: string;
  desc: string;
}
