import path from 'node:path';
import { probeVideoInfo, runFfmpeg } from './ffmpeg.js';
import type { FxCue } from './fx-catalog.js';
import { prepareFxClip, renderFxVideo, ensureFxRenderer, writeFxSpec } from './fxruntime.js';
import type { Cue } from './picker.js';

export interface RenderInput {
  video: string;
  cues: Cue[]; // sudah resolved (sfxFile absolut)
  fx?: FxCue[]; // efek visual + audio dari planner fx
  durationSec: number;
  /** direktori job — untuk fx_spec.json & video_fx.mp4 (default: folder output) */
  jobDir?: string;
  log?: (m: string) => void;
}

/** Parameter aecho per efek afx. Intensity memperkuat decay. */
function afxFilter(f: FxCue): string {
  const i = f.intensity;
  if (f.effect === 'reverb') {
    const d1 = (0.28 + 0.2 * i).toFixed(3);
    const d2 = (0.22 + 0.18 * i).toFixed(3);
    const d3 = (0.16 + 0.15 * i).toFixed(3);
    const d4 = (0.12 + 0.12 * i).toFixed(3);
    return `aecho=0.8:0.8:60\\,150\\,280\\,420:${d1}\\,${d2}\\,${d3}\\,${d4}`;
  }
  // echo (default)
  const decay1 = (0.3 + 0.3 * i).toFixed(3);
  const decay2 = (0.18 + 0.2 * i).toFixed(3);
  return `aecho=0.8:0.7:120\\,300:${decay1}\\,${decay2}`;
}

/**
 * Susun filter_complex FFmpeg:
 *   dialog asplit → key untuk sidechaincompress (auto-duck SFX saat dialog)
 *   tiap afx: aecho → isolasi taps (echo tanpa sinyal asli) → gate enable
 *     + afade halus → dicampur kembali ke dialog (bergema hanya di jendela cue)
 *   tiap SFX: aformat → adelay (penempatan detik) → volume (gain)
 *   bus SFX di-duck lalu digabung dengan dialog → normalize=0 (gain staging utuh)
 *
 * @param dialInputIndex indeks input FFmpeg untuk audio asli
 *   (0 = video utama; 1 kalau video utama sudah diganti hasil sidecar tanpa audio)
 */
export function buildFilterGraph(
  cues: Cue[],
  afx: FxCue[],
  durationSec: number,
  dialInputIndex = 0
): string | null {
  const afxOk = afx.filter((f) => f.end - f.start >= 0.15 && f.end > f.start);
  if (cues.length === 0 && afxOk.length === 0) return null;
  const parts: string[] = [];
  const hasSfx = cues.length > 0;

  // asplit dialog: [dial0] + [key] (kalau sfx) + 1 cabang per afx
  const splitLabels: string[] = ['dial0'];
  if (hasSfx) splitLabels.push('key');
  afxOk.forEach((_, i) => splitLabels.push(`ax${i}`));
  parts.push(`[${dialInputIndex}:a]asplit=${splitLabels.length}[${splitLabels.join('][')}]`);

  // cabang afx per cue
  afxOk.forEach((f, i) => {
    const gateStart = Math.max(0, f.start - 0.05);
    const fadeIn = Math.min(0.05, Math.max(0.01, f.start - gateStart));
    const fadeOutStart = Math.max(0, f.end - 0.03);
    const fadeOut = Math.min(0.03, Math.max(0.005, f.end - fadeOutStart));
    parts.push(`[ax${i}]asplit=2[cl${i}][ec${i}]`);
    parts.push(`[ec${i}]${afxFilter(f)}[eh${i}]`);
    // taps = echo − sinyal asli: balik → campur → balik lagi, sekalian digate
    parts.push(`[eh${i}]volume=-1[nv${i}]`);
    parts.push(`[cl${i}][nv${i}]amix=inputs=2:normalize=0[rm${i}]`);
    parts.push(
      `[rm${i}]volume=-1:enable='between(t,${gateStart.toFixed(3)},${f.end.toFixed(3)})':eval=frame[gt${i}]`
    );
    parts.push(`[gt${i}]afade=t=in:st=${gateStart.toFixed(3)}:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}[ex${i}]`);
  });

  // gabung dialog + taps afx → [dial]
  let dialLabel = 'dial0';
  if (afxOk.length > 0) {
    const ins = `[dial0]${afxOk.map((_, i) => `[ex${i}]`).join('')}`;
    parts.push(`${ins}amix=inputs=${1 + afxOk.length}:normalize=0:duration=first[dial]`);
    dialLabel = 'dial';
  }

  if (!hasSfx) {
    // tanpa SFX: dialog (mungkin berefek) → outa, dipotong + dipad ke durasi video
    parts.push(`[${dialLabel}]atrim=0:${durationSec.toFixed(3)},asetpts=PTS-STARTPTS,apad[outa]`);
    return parts.join(';');
  }

  const sfxStart = dialInputIndex + 1;
  const busLabels: string[] = [];
  cues.forEach((c, i) => {
    const ms = Math.max(0, Math.round(c.start * 1000));
    const label = `s${i}`;
    busLabels.push(label);
    parts.push(
      `[${sfxStart + i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
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
  parts.push(`[${dialLabel}][duck]amix=inputs=2:normalize=0:duration=first[outa]`);
  return parts.join(';');
}

/** Render video + cue list + efek → final.mp4. */
export async function renderVideo(input: RenderInput, outputPath: string): Promise<void> {
  const { video, cues, durationSec } = input;
  const log = input.log ?? (() => {});
  const fxAll = input.fx ?? [];

  // ---- 1. vfx: render visual lewat sidecar (gue fallback tanpa efek kalau gagal) ----
  let videoPath = video;
  const vfx = fxAll.filter((f) => f.kind === 'vfx' && f.end - f.start >= 0.12);
  if (vfx.length > 0) {
    try {
      const info = await probeVideoInfo(video);
      const plan = await prepareFxClip(video, info, log);
      const jobDir = input.jobDir ?? path.dirname(outputPath);
      const specPath = writeFxSpec(jobDir, {
        clip: path.basename(plan.clipPath),
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        duration: durationSec,
        cues: vfx,
      });
      const exe = await ensureFxRenderer(plan.width, plan.height, plan.fps, log);
      const vfxOut = path.join(jobDir, 'video_fx.mp4');
      await renderFxVideo({ exe, specPath, video: plan.clipPath, outPath: vfxOut, log });
      videoPath = vfxOut;
    } catch (e) {
      const first = (e as Error).message.split('\n')[0];
      log(`fx: vfx dilewati (${first}) — pakai video asli`);
      videoPath = video;
    }
  }

  // ---- 2. audio: SFX mix + afx gate; video: copy ----
  const afx = fxAll.filter((f) => f.kind === 'afx');
  const vfxActive = videoPath !== video;
  const dialIdx = vfxActive ? 1 : 0;
  const fg = buildFilterGraph(cues, afx, durationSec, dialIdx);

  if (!fg) {
    // tanpa cue audio sama sekali
    if (!vfxActive) {
      await runFfmpeg(['-i', video, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', outputPath]);
    } else {
      // video efek (senyap) + audio asli di-copy
      await runFfmpeg([
        '-i', videoPath, '-i', video,
        '-map', '0:v', '-map', '1:a?',
        '-c', 'copy', '-movflags', '+faststart', '-shortest',
        outputPath,
      ]);
    }
    return;
  }

  const args: string[] = ['-i', videoPath];
  if (vfxActive) args.push('-i', video); // audio asli jadi input dialog
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
