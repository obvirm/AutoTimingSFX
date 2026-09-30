import path from 'node:path';
import { runFfmpeg } from './ffmpeg.js';
import type { Cue } from './picker.js';

export interface RenderInput {
  video: string;
  cues: Cue[]; // sudah resolved (sfxFile absolut)
  durationSec: number;
}

/**
 * Susun filter_complex FFmpeg:
 *   dialog asplit → key untuk sidechaincompress (auto-duck SFX saat dialog)
 *   tiap SFX: aformat → adelay (penempatan detik) → volume (gain)
 *   bus SFX di-duck lalu digabung dengan dialog → normalize=0 (gain staging utuh)
 */
export function buildFilterGraph(cues: Cue[], durationSec: number): string | null {
  if (cues.length === 0) return null;
  const parts: string[] = [];
  parts.push(`[0:a]asplit=2[dial][key]`);

  const busLabels: string[] = [];
  cues.forEach((c, i) => {
    const ms = Math.max(0, Math.round(c.start * 1000));
    const label = `s${i}`;
    busLabels.push(label);
    parts.push(
      `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `adelay=${ms}|${ms}:all=1,volume=${c.gain.toFixed(4)}[${label}]`
    );
  });

  if (busLabels.length === 1) {
    parts.push(`[${busLabels[0]}]apad[busraw]`);
  } else {
    parts.push(`[${busLabels.join('][')}]amix=inputs=${busLabels.length}:normalize=0:duration=longest[busraw]`);
    parts.push(`[busraw]apad[busp]`);
  }
  const padLabel = busLabels.length === 1 ? 'busraw' : 'busp';
  parts.push(`[${padLabel}]atrim=0:${durationSec.toFixed(3)},asetpts=PTS-STARTPTS[buss]`);
  parts.push(`[buss][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
  parts.push(`[dial][duck]amix=inputs=2:normalize=0:duration=first[outa]`);
  return parts.join(';');
}

/** Render video + cue list → final.mp4. */
export async function renderVideo(input: RenderInput, outputPath: string): Promise<void> {
  const { video, cues, durationSec } = input;
  const fg = buildFilterGraph(cues, durationSec);
  if (!fg) {
    // tanpa cue: salin apa adanya
    await runFfmpeg([
      '-i', video,
      '-map', '0:v', '-map', '0:a?',
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);
    return;
  }
  const args: string[] = ['-i', video];
  for (const c of cues) args.push('-i', c.sfxFile);
  args.push(
    '-filter_complex', fg,
    '-map', '0:v', '-map', '[outa]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath
  );
  await runFfmpeg(args);
}

export function cueArtifactsPath(jobDir: string): string {
  return path.join(jobDir, 'cue_list.json');
}
