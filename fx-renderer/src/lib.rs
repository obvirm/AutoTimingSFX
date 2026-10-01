//! Fx Renderer — sidecar AutoTimingSFX.
//!
//! Membaca footage asli + `fx_spec.json`, lalu me-render ulang video (SVG/Skia
//! lewat fframes) dengan efek visual (vfx) di atasnya menjadi mp4 **senyap**.
//! Audio (SFX + afx) dihitung terpisah oleh FFmpeg di `src/render.ts`.
//!
//! Kontrak dengan pipeline:
//! - `fx-renderer --spec <fx_spec.json> --video <clip.mp4> render -o <out.mp4>`
//! - `src/generated.rs` ditulis pipeline (WIDTH/HEIGHT/FPS); default 1920x1080@30
//! - `spec.clip` = basename dari `--video`; cue vfx saja di sini (afx = FFmpeg)
use fframes::{
    AudioMap, Color, Duration, FFramesContext, FFramesSyncedVideoFrame, Frame, Svgr,
    SyncVideoFrameInput, Transform, Video, include_media_dir, svgr,
};
use serde::Deserialize;
use std::path::Path;

mod generated;
pub use generated::{FPS, HEIGHT, WIDTH};

// Font DM Sans di-embed dari `media/`; nama keluarga dipakai via `font-family`.
include_media_dir!(pub struct FxRendererMedia, "media");

const FONT: &str = "DM Sans";
const WEIGHT: u16 = 500;
/// Skala ukuran: 1.0 pada 1080p (lanskap/potret).
const UNIT: f32 = (if WIDTH < HEIGHT { WIDTH } else { HEIGHT }) as f32 / 1080.0;
const W: f32 = WIDTH as f32;
const H: f32 = HEIGHT as f32;
const CX: f32 = W / 2.;
const CY: f32 = H / 2.;

/// Satu efek visual dari planner (lihat `src/fx-catalog.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct Cue {
    pub id: String,
    pub kind: String,
    pub effect: String,
    pub start: f32,
    pub end: f32,
    pub intensity: f32,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub reason: String,
}

/// Isi `fx_spec.json` yang ditulis pipeline.
#[derive(Debug, Deserialize)]
pub struct Spec {
    pub clip: String,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub duration: f32,
    #[serde(default)]
    pub cues: Vec<Cue>,
}

impl Spec {
    pub fn parse(raw: &str) -> Result<Spec, String> {
        serde_json::from_str(raw).map_err(|e| format!("fx_spec.json tidak valid: {e}"))
    }

    pub fn load(path: &Path) -> Result<Spec, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("gagal baca {}: {e}", path.display()))?;
        Spec::parse(&raw)
    }
}

impl Cue {
    pub fn contains(&self, t: f32) -> bool {
        t >= self.start && t < self.end
    }

    /// Posisi 0..1 dalam cue (di-clamp).
    pub fn progress(&self, t: f32) -> f32 {
        ((t - self.start) / (self.end - self.start).max(1e-4)).clamp(0., 1.)
    }
}

// ---- envelope: dipakai render_frame & unit test ----

/// 0 → 1 → 0 (sinus) — naik mulus di tengah cue, turun di ujung.
pub fn bell(p: f32) -> f32 {
    (std::f32::consts::PI * p.clamp(0., 1.)).sin()
}

pub fn ease_out_cubic(p: f32) -> f32 {
    let p = p.clamp(0., 1.);
    1. - (1. - p).powi(3)
}

/// Overshoot di awal lalu kembali ke 1 (untuk punch/scale-in).
pub fn ease_out_back(p: f32) -> f32 {
    let p = p.clamp(0., 1.);
    let c1 = 1.70158;
    let c3 = c1 + 1.;
    1. + c3 * (p - 1.).powi(3) + c1 * (p - 1.).powi(2)
}

/// Dua sisi: fade-in `in_frac`, fade-out `out_frac`, plateau di tengah.
pub fn fade_pair(p: f32, in_frac: f32, out_frac: f32) -> f32 {
    let p = p.clamp(0., 1.);
    let fin = if in_frac > 0. { (p / in_frac).min(1.) } else { 1. };
    let fout = if out_frac > 0. { ((1. - p) / out_frac).min(1.) } else { 1. };
    fin.min(fout)
}

fn hex_color<'a>(c: &'a Option<String>, fallback: &'static str) -> &'a str {
    match c.as_deref() {
        Some(s) if s.starts_with('#') && s.len() >= 4 => s,
        _ => fallback,
    }
}

/// Video: footage + vfx → SVG per frame. Tanpa audio (AudioMap::none()).
pub struct FxRendererVideo<'a> {
    pub spec: &'a Spec,
}

impl<'a> FxRendererVideo<'a> {
    pub fn new(spec: &'a Spec) -> Self {
        Self { spec }
    }

    /// Cue vfx yang aktif di detik `t` (validator menjamin non-tumpang-tindih).
    fn active(&self, t: f32) -> Option<&Cue> {
        self.spec
            .cues
            .iter()
            .find(|c| c.kind == "vfx" && c.contains(t))
    }
}

impl std::fmt::Debug for FxRendererVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FxRendererVideo")
            .field("clip", &self.spec.clip)
            .field("cues", &self.spec.cues.len())
            .field("duration", &self.spec.duration)
            .finish()
    }
}

impl Video for FxRendererVideo<'_> {
    const FPS: usize = FPS;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.spec.duration)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();

        // Footage: frame video di-sync ke detik ini (tanpa looping — klip sudah
        // dinormalisasi & durasinya sama dengan spec.duration).
        let img = frame
            .get_synced_video_frame(
                ctx,
                self.spec.clip.as_str(),
                &SyncVideoFrameInput {
                    start_from: 0.,
                    looping: false,
                    editor_fallback_image: None,
                },
            )
            .map(|buf| buf.into_image());
        // href (Arc) dipakai berkali-kali tanpa decode ulang; dm = apakah decode gagal.
        let href = img.as_ref().map(|i| i.href());
        let mkbase = || match &href {
            Some(h) => svgr!(<image x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid slice" href={h.clone()} />),
            None => svgr!(<rect x={0} y={0} width={W} height={H} fill="#111318" />),
        };

        let Some(cue) = self.active(t) else {
            return svgr!(<svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>{mkbase()}</svg>);
        };

        let p = cue.progress(t);
        let i = cue.intensity.clamp(0.1, 1.);
        let inner: Svgr = match cue.effect.as_str() {
            // saturate 1 → 0: hitam-putih pelan lalu kembali
            "grayscale" => {
                let sat = 1. - bell(p) * i;
                svgr!(<g>
                    <defs><filter id="fx" x="0%" y="0%" width="100%" height="100%">
                        <feColorMatrix type="saturate" values={format!("{sat:.3}")} />
                    </filter></defs>
                    <g filter="url(#fx)">{mkbase()}</g>
                </g>)
            }
            // blur naik-turun cepat
            "blur_pulse" => {
                let std = bell(p) * i * 14. * UNIT;
                svgr!(<g>
                    <defs><filter id="fx" x="-15%" y="-15%" width="130%" height="130%">
                        <feGaussianBlur stdDeviation={std} />
                    </filter></defs>
                    <g filter="url(#fx)">{mkbase()}</g>
                </g>)
            }
            // irisan bergeser + ghost merah/cyan
            "glitch_slice" => {
                let o = bell(p) * i * 26. * UNIT;
                let h = ((p * 977. + 13.) % 1.).abs();
                let by = H * (0.1 + 0.75 * h);
                let bh = H * (0.05 + 0.1 * (1. - h));
                let bdx = if h > 0.5 { o * 2.2 } else { -o * 2.2 };
                let gop = bell(p) * 0.85;
                svgr!(<g>
                    <defs>
                        <filter id="red" x="-5%" y="-5%" width="110%" height="110%">
                            <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
                        </filter>
                        <filter id="cyan" x="-5%" y="-5%" width="110%" height="110%">
                            <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" />
                        </filter>
                        <clipPath id="band"><rect x={0} y={by} width={W} height={bh} /></clipPath>
                    </defs>
                    {mkbase()}
                    <g opacity={gop}>
                        <g filter="url(#red)" transform={Transform::translate(o, 0.)}>{mkbase()}</g>
                        <g filter="url(#cyan)" transform={Transform::translate(-o, 0.)}>{mkbase()}</g>
                    </g>
                    <g clip-path="url(#band)" transform={Transform::translate(bdx, 0.)}>{mkbase()}</g>
                </g>)
            }
            // zoom-in pegas sekali keras
            "zoom_punch" => {
                let punch = if p < 0.3 { ease_out_back(p / 0.3) } else { (1. - (p - 0.3) / 0.7).powi(2) };
                let s = 1. + 0.14 * i * punch.max(0.);
                let mut tr = Transform::translate(CX * (1. - s), CY * (1. - s));
                tr.scale = s.into();
                svgr!(<g><g transform={tr}>{mkbase()}</g></g>)
            }
            // kamera bergetar kuat (translate jitter)
            "shake" => {
                let amp = bell(p) * i;
                let dx = (t * 53.).sin() * amp * 24. * UNIT;
                let dy = (t * 41.).cos() * amp * 18. * UNIT;
                svgr!(<g><g transform={Transform::translate(dx, dy)}>{mkbase()}</g></g>)
            }
            // kilat putih sekali, decay cepat
            "flash" => {
                let op = i * (1. - p).powf(1.4);
                svgr!(<g>{mkbase()}<rect x={0} y={0} width={W} height={H} fill="#ffffff" opacity={op} /></g>)
            }
            // teks besar pop-in di tengah
            "text_pop" => {
                let raw = cue.text.as_deref().unwrap_or("").trim();
                if raw.is_empty() {
                    svgr!(<g>{mkbase()}</g>)
                } else {
                    let n = raw.chars().count().max(1) as f32;
                    let size = (H * 0.15).min(W * 0.86 / (n * 0.56));
                    let pop = if p < 0.22 { ease_out_back(p / 0.22) } else { 1. };
                    let alpha = fade_pair(p, 0.1, 0.2) * i;
                    let mut tr = Transform::translate(CX * (1. - pop), CY * (1. - pop));
                    tr.scale = pop.into();
                    let y = CY + size * 0.34;
                    let shadow = size * 0.05;
                    svgr!(<g>
                        {mkbase()}
                        <g transform={tr} opacity={alpha}>
                            <text x={CX} y={y + shadow} font-family={FONT} font-size={size} font-weight={WEIGHT} fill="#000000" opacity={0.55} text-anchor="middle">{raw}</text>
                            <text x={CX} y={y} font-family={FONT} font-size={size} font-weight={WEIGHT} fill="#ffffff" text-anchor="middle">{raw}</text>
                        </g>
                    </g>)
                }
            }
            // tepi menggelap, fokus ke tengah
            "vignette_dark" => {
                let op = bell(p) * i;
                svgr!(<g>
                    <defs><radialGradient id="fx" cx="0.5" cy="0.5" r="0.75">
                        <stop offset="0.35" stop-color="#000000" stop-opacity="0" />
                        <stop offset="1" stop-color="#000000" stop-opacity="1" />
                    </radialGradient></defs>
                    {mkbase()}
                    <rect x={0} y={0} width={W} height={H} fill="url(#fx)" opacity={op} />
                </g>)
            }
            // garis scan retro bergeser
            "scanlines" => {
                let off = (t * 90.) % 8.;
                let op = bell(p) * i * 0.6;
                svgr!(<g>
                    <defs><pattern id="fx" x="0" y={off} width="8" height="8" patternUnits="userSpaceOnUse">
                        <rect x={0} y={0} width="8" height="4" fill="#000000" />
                    </pattern></defs>
                    {mkbase()}
                    <rect x={0} y={0} width={W} height={H} fill="url(#fx)" opacity={op} />
                </g>)
            }
            // ledakan partikel dari tengah
            "particles" => {
                let reach = H * 0.55;
                let parts = (0..32u32)
                    .map(|k| {
                        let h = (k.wrapping_mul(2654435761) % 997) as f32 / 997.;
                        let h2 = ((k.wrapping_mul(40503) + 7919) % 991) as f32 / 991.;
                        let ang = k as f32 * 0.6283185 + h * 0.6;
                        let d = ease_out_cubic(p) * reach * (0.3 + 0.7 * h2) * (0.45 + 0.55 * i);
                        let x = CX + ang.cos() * d;
                        let y = CY + ang.sin() * d;
                        let r = (2.5 + h * 5.) * UNIT * (1. + i * 0.6);
                        let op = ((1. - p) * (0.45 + 0.55 * h) * i).clamp(0., 1.);
                        svgr!(<circle cx={x} cy={y} r={r} fill="#ffffff" opacity={op} />)
                    })
                    .collect::<Svgr>();
                svgr!(<g>{mkbase()}{parts}</g>)
            }
            // garis kecepatan radial masuk dari tepi
            "speedlines" => {
                let ease = ease_out_cubic(p);
                let lines = (0..24u32)
                    .map(|k| {
                        let h = ((k.wrapping_mul(2246822519) + 3266489917) % 983) as f32 / 983.;
                        let ang = k as f32 * 15. + h * 7.;
                        let len = W * (0.14 + 0.28 * h) * ease * (0.5 + 0.5 * i);
                        let th = (1.6 + h * 3.4) * UNIT;
                        let op = bell(p) * (0.45 + 0.55 * h);
                        svgr!(<g transform={format!("rotate({ang} {CX} {CY})")}>
                            <rect x={0} y={CY - th / 2.} width={len} height={th} fill="#ffffff" opacity={op} />
                        </g>)
                    })
                    .collect::<Svgr>();
                svgr!(<g>{mkbase()}{lines}</g>)
            }
            // denyut warna layar penuh
            "color_pulse" => {
                let col = hex_color(&cue.color, "#ef4444");
                let pulse = 0.65 + 0.35 * (t * 9.).sin();
                let op = bell(p) * i * 0.45 * pulse;
                svgr!(<g>{mkbase()}<rect x={0} y={0} width={W} height={H} fill={col} opacity={op} /></g>)
            }
            // bar sinematik hitam atas-bawah
            "letterbox" => {
                let bh = H * 0.14 * bell(p) * i;
                svgr!(<g>
                    {mkbase()}
                    <rect x={0} y={0} width={W} height={bh} fill="#000000" />
                    <rect x={0} y={H - bh} width={W} height={bh} fill="#000000" />
                </g>)
            }
            // nama tak dikenal (atau cue afx yang bocor) → footage polos
            _ => svgr!(<g>{mkbase()}</g>),
        };

        svgr!(<svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>{inner}</svg>)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(effect: &str, start: f32, end: f32) -> Cue {
        Cue {
            id: "fx1".into(),
            kind: "vfx".into(),
            effect: effect.into(),
            start,
            end,
            intensity: 0.8,
            text: None,
            color: None,
            reason: String::new(),
        }
    }

    #[test]
    fn parses_spec_json() {
        let spec = Spec::parse(
            r#"{"clip":"a.mp4","width":1920,"height":1080,"fps":30,"duration":12.5,
               "cues":[{"id":"fx1","kind":"vfx","effect":"flash","start":1,"end":1.4,
                        "intensity":0.9,"reason":"x"}]}"#,
        )
        .unwrap();
        assert_eq!(spec.clip, "a.mp4");
        assert_eq!(spec.cues.len(), 1);
        assert_eq!(spec.cues[0].effect, "flash");
        assert_eq!(spec.cues[0].text, None);
    }

    #[test]
    fn rejects_bad_spec() {
        assert!(Spec::parse("not json").is_err());
        assert!(Spec::parse(r#"{"width":1}"#).is_err()); // clip wajib
    }

    #[test]
    fn cue_window_and_progress() {
        let c = cue("flash", 2., 3.);
        assert!(!c.contains(1.99));
        assert!(c.contains(2.));
        assert!(c.contains(2.99));
        assert!(!c.contains(3.));
        assert!((c.progress(2.) - 0.).abs() < 1e-6);
        assert!((c.progress(2.5) - 0.5).abs() < 1e-6);
        assert!(c.progress(9.) <= 1.);
    }

    #[test]
    fn envelopes_are_bounded() {
        for k in 0..=20 {
            let p = k as f32 / 20.;
            let b = bell(p);
            assert!((-1e-6..=1. + 1e-6).contains(&b), "bell({p}) = {b}");
            let f = fade_pair(p, 0.1, 0.2);
            assert!((0. ..=1. + 1e-6).contains(&f), "fade_pair({p}) = {f}");
        }
        assert!((bell(0.5) - 1.).abs() < 1e-4);
        assert!(bell(0.) < 1e-6 && bell(1.) < 1e-6);
        assert!((ease_out_cubic(0.)).abs() < 1e-6);
        assert!((ease_out_cubic(1.) - 1.).abs() < 1e-6);
        assert!((ease_out_back(1.) - 1.).abs() < 1e-3);
    }

    #[test]
    fn active_picks_only_vfx_in_window() {
        let spec = Spec::parse(
            r#"{"clip":"a.mp4","width":1920,"height":1080,"fps":30,"duration":10,
               "cues":[
                 {"id":"fx1","kind":"vfx","effect":"flash","start":1,"end":2,"intensity":1,"reason":""},
                 {"id":"ax1","kind":"afx","effect":"echo","start":3,"end":4,"intensity":1,"reason":""}
               ]}"#,
        )
        .unwrap();
        let v = FxRendererVideo::new(&spec);
        assert_eq!(v.active(1.5).map(|c| c.effect.as_str()), Some("flash"));
        assert!(v.active(3.5).is_none()); // afx tidak di-render visual
        assert!(v.active(0.5).is_none());
    }
}
