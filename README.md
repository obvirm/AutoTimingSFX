# AutoTimingSFX

AI timing picker untuk **SFX library milikmu sendiri**: video → analisis VLM
(video+audio, **tanpa transkrip lokal**) → manifest beat → pemilihan SFX
(RAG di atas deskripsi yang **kamu tulis sendiri**) → render FFmpeg dengan
penempatan presisi.

Satu shot (pola movie2short): semua tahap jalan dalam satu job, hasilnya bisa
diedit (cue list) lalu di-re-render tanpa mengulang pipeline.

## Persyaratan

- Node.js ≥ 20 (dites di v25)
- FFmpeg di PATH (detes di 8.1.2)
- Model embedding (otomatis diunduh sekali dari HuggingFace)

## Menjalankan

```bash
npm install
cp .env.example .env        # isi OPENAI_BASE_URL / OPENAI_API_KEY / model
npm start                   # API  → http://localhost:3132
npm run dev:studio          # UI dev → http://localhost:5188 (proxy ke 3132)
npm run build:studio        # bundle UI; API lalu menyajikannya di :3132
```

UI: **Library** (impor MP3 → dengar → tulis deskripsi), **Job Baru** (upload video,
prompt), **Riwayat**, **detail job** (log, video hasil, editor cue →
re-render), **Pengaturan**.

## Model gateway (penting)

Proyek memakai gateway OpenAI-compatible apa pun. Konfigurasi aktif (lihat `.env`):

| Item | Nilai |
|---|---|
| `OPENAI_BASE_URL` | `http://localhost:20128/v1` (9router lokal, proses `9router/app/custom-server.js`) |
| `MODEL_NAME` / `VLM_MODEL` | `ag/gemini-3.6-flash-high` (teruji teks + **video+audio**) |
| `LLM_FALLBACK_MODELS` | kosong — hanya varian itu yang valid di gateway (`ag/gemini-3.6-flash`, `3.7-flash`, dll → 404) |

**Syarat keras `VLM_MODEL`: wajib menerima input video+audio.** Pipeline
mengirim tiap segmen 40 detik sebagai `data:video/mp4;base64` (audio ikut di
dalamnya) di slot `image_url` — model kelas Gemini / GPT-4o-class yang
mendengar audio langsung. Model yang hanya menerima gambar/still frame akan
gagal atau buta suara; jangan pakai.

Catatan gateway 9router:

- **Selalu kirim `stream: false`** — tanpa field itu server membalas SSE;
  `src/openai.ts` sudah mengirimnya + punya parser SSE cadangan. Jangan dihapus.
- `GET /v1/models` menggantung (hang) — jangan dipakai untuk daftar model.
- Model lama di `router.bynara.id` (`space-bunny-alpha`, `nemotron-3.5-lightning-free`)
  masih bisa dipakai dengan mengganti `OPENAI_BASE_URL` + key lewat **Pengaturan**
  — catatan: akun itu tanpa kredit untuk model berbayar, dan kadang membalas
  HTTP 200 tetapi body `{"error":…}` (lapisan retry di `openai.ts` sudah
  menangani itu).

## Alur pipeline & kebijakan SFX

1. `probe` → durasi via ffprobe
2. `analyze` — video dipotong per **40 detik (audio ikut)** → tiap segmen
   dikirim ke VLM sebagai video base64 → momen (transisi/aksi/emosi/audio)
   dengan timestamp global → `events.json`
3. `manifest` — LLM menyusun beat dari momen + prompt
4. `pick` — RAG (embedding lokal `paraphrase-multilingual-MiniLM-L12-v2`,
   fallback skor token) kandidat per beat → LLM memilih SFX + anchor →
   validasi kepadatan: `SFX_MIN_GAP_SEC` (default 5 dtk), `SFX_MAX_PER_BEAT` (1),
   impact ditempatkan `RENDER_LEAD_MS` (−120 ms) sebelum momen (precedence
   manusia), dikoreksi `onset_ms` hasil analisis audio.
5. `render` — filter_complex: dialog `asplit` → sidechain auto-duck, tiap SFX
   `adelay`+`volume`, bus `amix normalize=0` → `apad/atrim` → campur final.

Semua cue punya `reason` yang bisa dicek di UI; `cue_list.json` tersimpan per
job dan bisa diedit lalu di-re-render.

**Tidak ada transkripsi lokal lagi.** Whisper ONNX & audio.cpp dihapus dari
jalur produk (2026-09-30): timing beat berasal dari timestamp VLM (akurasi
±0,5 dtk wajar — presisi halus diatur manual via editor cue).

## Skrip

```bash
npm test               # vitest: util, filter graph, chunkRanges, pencarian
npm run typecheck      # tsc backend + studio
npx tsx scripts/smoke.ts   # uji API/library in-process
npx tsx scripts/e2e.ts     # uji pipeline penuh (video → job → verifikasi)
```

## Struktur

```
data/        runtime: autosfx.db (SQLite), sfx/, uploads/, output/jobs/<id>/, settings.json
src/         backend TS (server, pipeline, visual, manifest, picker, render)
studio/      UI Vite + React (tema studio gelap)
scripts/     smoke & e2e
tests/       vitest
NOTES.txt    catatan keputusan desain (baca dulu sebelum ubah perilaku)
```
