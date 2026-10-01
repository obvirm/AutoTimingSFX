export type FxKind = 'vfx' | 'afx';

export interface FxCue {
  id: string;
  kind: FxKind;
  /** nama efek — harus terdaftar di FX_CATALOG */
  effect: string;
  /** detik mulai (global, relatif video) */
  start: number;
  /** detik selesai */
  end: number;
  /** 0..1 — kekuatan efek */
  intensity: number;
  /** teks untuk efek teks (opsional) */
  text?: string;
  /** warna hex untuk efek berwarna (opsional) */
  color?: string;
  reason: string;
}

export interface FxDef {
  name: string;
  kind: FxKind;
  /** deskripsi buat LLM planner */
  desc: string;
  minDur: number;
  maxDur: number;
  defaultDur: number;
  needText?: boolean;
  needColor?: boolean;
}

/**
 * Katalog efek. Sumber kebenaran untuk LLM planner; nama di sini WAJIB
 * cocok dengan match arm di fx-renderer/src/lib.rs (vfx) / buildFilterGraph (afx).
 */
export const FX_CATALOG: FxDef[] = [
  // ---- vfx: di-render sidecar Rust (fframes) di atas footage asli ----
  { name: 'grayscale', kind: 'vfx', desc: 'video perlahan jadi hitam-putih lalu kembali warna (momen refleksi/serius)', minDur: 0.8, maxDur: 4, defaultDur: 2 },
  { name: 'blur_pulse', kind: 'vfx', desc: 'blur naik-turun cepat — perhatian tersesat sesaat', minDur: 0.3, maxDur: 1.5, defaultDur: 0.8 },
  { name: 'glitch_slice', kind: 'vfx', desc: 'glitch RGB: irisan gambar bergeser + ghost merah/cyan (kesan rusak/digital)', minDur: 0.25, maxDur: 1.5, defaultDur: 0.7 },
  { name: 'zoom_punch', kind: 'vfx', desc: 'zoom-in pegas sekali keras di titik kejutan/punchline', minDur: 0.3, maxDur: 1, defaultDur: 0.6 },
  { name: 'shake', kind: 'vfx', desc: 'kamera bergetar kuat (ledakan, teriakan, gempa)', minDur: 0.3, maxDur: 1.5, defaultDur: 0.8 },
  { name: 'flash', kind: 'vfx', desc: 'kilat putih singkat sekali di detik kejutan', minDur: 0.15, maxDur: 0.5, defaultDur: 0.3 },
  { name: 'text_pop', kind: 'vfx', desc: 'teks besar pop-in di tengah layar (kata kunci/punchline 1-4 kata)', minDur: 0.8, maxDur: 3, defaultDur: 1.6, needText: true },
  { name: 'vignette_dark', kind: 'vfx', desc: 'tepi video menggelap — fokus/tensi meningkat', minDur: 1, maxDur: 4, defaultDur: 2.5 },
  { name: 'scanlines', kind: 'vfx', desc: 'garis scan retro bergerak (nuansa rekaman/CCTV/game lama)', minDur: 0.6, maxDur: 3, defaultDur: 1.5 },
  { name: 'particles', kind: 'vfx', desc: 'ledakan partikel kecil dari tengah layar (impact/kejutan)', minDur: 0.5, maxDur: 2, defaultDur: 1.2 },
  { name: 'speedlines', kind: 'vfx', desc: 'garis kecepatan radial masuk dari tepi (transisi cepat/energik)', minDur: 0.4, maxDur: 1.5, defaultDur: 0.9 },
  { name: 'color_pulse', kind: 'vfx', desc: 'denyut warna layar penuh (merah=bahaya, biru=kedinginan, hijau=aneh)', minDur: 0.6, maxDur: 3, defaultDur: 1.5, needColor: true },
  { name: 'letterbox', kind: 'vfx', desc: 'bar sinematik hitam menutup atas-bawah (momen sinematik/serius)', minDur: 1, maxDur: 4, defaultDur: 2.5 },
  // ---- afx: filter audio FFmpeg pada track dialog/suara asli ----
  { name: 'echo', kind: 'afx', desc: 'gema pendek pada suara/dialog (bergema)', minDur: 0.4, maxDur: 4, defaultDur: 1.2 },
  { name: 'reverb', kind: 'afx', desc: 'gema panjang seperti di ruangan besar/gua', minDur: 0.8, maxDur: 5, defaultDur: 2.5 },
];

const byName = new Map(FX_CATALOG.map((f) => [f.name, f]));

export function fxDef(name: string): FxDef | undefined {
  return byName.get(name);
}

/** Batas global (validator memotong sisanya). */
export const FX_MAX_VFX = 12;
export const FX_MAX_AFX = 6;
/** Durasi video > ini → planner dibatasi lebih konservatif. */
export const FX_LONG_VIDEO_SEC = 120;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Validasi hasil LLM → FxCue[] bersih:
 * - efek harus ada di katalog, waktu di-clamp, intensity 0.1..1
 * - text_pop tanpa teks / color_pulse tanpa warna → dibuang
 * - minimum durasi dipaksa (perpanjang end bila perlu, dibatasi maxDur)
 * - vfx & afx tidak boleh saling tumpang-tindih (potong ke mulai berikutnya)
 * - batas global per jenis
 */
export function validateFx(raw: unknown, durationSec: number): FxCue[] {
  const list = Array.isArray(raw) ? raw : [];
  const sorted = list
    .map((r: any) => ({
      effect: String(r?.effect ?? ''),
      start: num(r?.start, NaN),
      end: num(r?.end, NaN),
      intensity: num(r?.intensity, 0.7),
      text: r?.text !== undefined && r?.text !== null ? String(r.text).slice(0, 60) : undefined,
      color: r?.color !== undefined && r?.color !== null ? String(r.color).slice(0, 20) : undefined,
      reason: String(r?.reason ?? '').slice(0, 300),
    }))
    .filter((r) => fxDef(r.effect) && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ ...r, start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100 }))
    .sort((a, b) => a.start - b.start);

  const out: Record<FxKind, FxCue[]> = { vfx: [], afx: [] };
  const idSeq: Record<FxKind, number> = { vfx: 0, afx: 0 };

  for (const r of sorted) {
    const def = fxDef(r.effect)!;
    if (def.needText && !(r.text ?? '').trim()) continue;
    if (def.needColor && !/^#[0-9a-fA-F]{3,8}$/.test(r.color ?? '')) {
      r.color = '#ef4444'; // fallback merah
    }
    let start = clamp(r.start, 0, durationSec - 0.1);
    let end = clamp(r.end, start + 0.05, durationSec);
    if (end - start < def.minDur) end = Math.min(durationSec, start + def.minDur);
    if (end - start > def.maxDur) end = start + def.maxDur;
    if (end - start < 0.12) continue;
    const intensity = clamp(r.intensity, 0.1, 1);

    // tumpang tindih dalam jenis yang sama → potong mulai ke akhir sebelumnya
    const bucket = out[def.kind];
    const prev = bucket[bucket.length - 1];
    if (prev && start < prev.end) {
      start = prev.end;
      if (end - start < Math.max(0.12, def.minDur * 0.5)) continue;
    }
    const cap = def.kind === 'vfx' ? FX_MAX_VFX : FX_MAX_AFX;
    if (bucket.length >= cap) continue;

    bucket.push({
      id: `${def.kind === 'vfx' ? 'fx' : 'ax'}${++idSeq[def.kind]}`,
      kind: def.kind,
      effect: r.effect,
      start,
      end: Math.round(end * 100) / 100,
      intensity: Math.round(intensity * 100) / 100,
      ...(r.text ? { text: r.text } : {}),
      ...(r.color ? { color: r.color } : {}),
      reason: r.reason,
    });
  }

  return [...out.vfx, ...out.afx];
}

/** Ringkasan katalog → brief prompt untuk LLM. */
export function fxCatalogBrief(): string {
  return FX_CATALOG.map(
    (f) =>
      `- ${f.name} [${f.kind}] ${f.desc} (durasi ${f.minDur}-${f.maxDur}s, default ${f.defaultDur}s${
        f.needText ? ', WAJIB isi "text" (1-4 kata)' : ''
      }${f.needColor ? ', isi "color" hex (mis. #ef4444)' : ''})`
  ).join('\n');
}
