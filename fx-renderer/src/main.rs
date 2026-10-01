//! CLI sidecar: `fx-renderer --spec fx_spec.json --video clip.mp4 render -o out.mp4`
//!
//! Media runtime: hanya clip `--video` yang didaftarkan (tanpa membaca folder) —
//! font datang dari `media/` embed. Output selalu senyap (AudioMap::none()).
use fframes::{EncoderOptions, RenderOptions, StaticMediaProvider, cli};
use fframes::cli::clap; // derive di bawah melebar ke `clap::...`
use fframes_skia_renderer::{
    SkiaFFramesRenderer, SkiaPipelineConcurrencyPolicy, SkiaPipelineConfig,
    vulkan::SkiaVulkanCtx,
};
use fx_renderer::{FxRendererMedia, FxRendererVideo, HEIGHT, Spec, WIDTH};
use std::path::PathBuf;
use std::process::ExitCode;

/// Argumen di atas subcommand fframes (render, frame, strip, ...).
#[derive(Debug, clap::Args)]
struct VideoArgs {
    /// fx_spec.json dari pipeline (timeline + parameter efek)
    #[arg(long)]
    spec: PathBuf,
    /// Footage asli (hasil normalisasi dari pipeline)
    #[arg(long)]
    video: PathBuf,
}

fn main() -> ExitCode {
    let args = cli::parse::<VideoArgs>();
    let spec = match Spec::load(&args.app.spec) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("fx-renderer: {e}");
            return ExitCode::FAILURE;
        }
    };
    let video_path = &args.app.video;
    let Some(file_name) = video_path.file_name().map(|s| s.to_string_lossy().into_owned()) else {
        eprintln!("fx-renderer: --video harus menunjuk ke file");
        return ExitCode::FAILURE;
    };

    // Font embed + provider runtime berisi tepat satu video (klip kerja).
    let static_media = FxRendererMedia::prepare().expect("media font");
    let mut videos = std::collections::HashMap::new();
    videos.insert(
        file_name,
        fframes::media::VideoMedia {
            path: video_path.clone(),
            metadata: None,
        },
    );
    let runtime = fframes::DynamicMediaProvider::new(
        Default::default(),
        Default::default(),
        Default::default(),
        videos,
        Vec::new(),
    );
    let combined =
        fframes::CombinedMediaProvider::from([&static_media as &dyn fframes::MediaProvider, &runtime]);

    let video = FxRendererVideo::new(&spec);
    let gpu = SkiaVulkanCtx::new(WIDTH, HEIGHT).expect("GPU (Vulkan) context");

    // Segmen render sementara jangan sampai ke C: yang penuh — pakai FX_TMP/D:\tmp.
    let mut tmp_dir = match std::env::var("FX_TMP") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => PathBuf::from("D:\\tmp"),
    };
    if std::fs::create_dir_all(&tmp_dir).is_err() {
        tmp_dir = std::env::temp_dir();
    }

    cli::new(
        &video,
        RenderOptions {
            media: Some(&combined),
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "18"), ("preset", "fast")]),
                ..Default::default()
            },
            tmp_files_directory: Some(&tmp_dir),
            ..Default::default()
        },
    )
    .args(args)
    .backend(
        SkiaFFramesRenderer::new_vulkan(
            &gpu,
            SkiaPipelineConfig {
                concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance,
                ..Default::default()
            },
        )
        .expect("skia renderer"),
    )
    .preview(fframes_native_player::cli_preview)
    .run()
}
