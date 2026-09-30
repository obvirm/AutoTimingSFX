# AutoTimingSFX

AI timing picker untuk **SFX library milikmu sendiri**: video → transkrip (Whisper) →
deteksi momen visual (VLM) → manifest beat → pemilihan SFX (RAG di atas deskripsi
yang **kamu tulis sendiri**) → render FFmpeg dengan penempatan presisi.

Satu shot (pola movie2short): semua tahap jalan dalam satu job, hasilnya bisa
diedit (cue list) lalu di-re-render tanpa mengulang pipeline.

## Persyaratan

- Node.js ≥ 20 (dites di v25)
- FFmpeg di PATH (detes di 8.1.2)
- Model Whisper ONNX (otomatis diunduh sekali dari HuggingFace)
- Opsional: [audio.cpp](https://github.com/0xShug0/audio.cpp) untuk engine kedua

## Menjalankan

```bash
npm install
cp .env.example .env        # isi OPENAI_BASE_URL / OPENAI_API_KEY / model
npm start                   # API  → http://localhost:3132
npm run dev:studio          # UI dev → http://localhost:5188 (proxy ke 3132)
npm run build:studio        # bundle UI; API lalu menyajikannya di :3132
```

UI: **Library** (impor MP3 → dengar → tulis deskripsi), **Job Baru** (upload video,
prompt, engine), **Riwayat**, **detail job** (log, video hasil, editor cue →
re-render), **Pengaturan**.

## Model gateway (penting)

Proyek memakai gateway OpenAI-compatible apa pun. Konfigurasi aktif (lihat `.env`):

| Item | Nilai |
|---|---|
| `OPENAI_BASE_URL` | `http://localhost:20128/v1` (9router lokal, proses `9router/app/custom-server.js`) |
| `MODEL_NAME` / `VLM_MODEL` | `ag/gemini-3.6-flash-high` (teruji teks + vision) |
| `LLM_FALLBACK_MODELS` | kosong — hanya varian itu yang valid di gateway (`ag/gemini-3.6-flash`, `3.7-flash`, dll → 404) |

Catatan gateway 9router:

- **Selalu kirim `stream: false`** — tanpa field itu server membalas SSE;
  `src/openai.ts` sudah mengirimnya + punya parser SSE cadangan. Jangan dihapus.
- `GET /v1/models` menggantung (hang) — jangan dipakai untuk daftar model.
- Model lama di `router.bynara.id` (`space-bunny-alpha`, `nemotron-3.5-lightning-free`)
  masih bisa dipakai dengan mengganti `OPENAI_BASE_URL` + key lewat **Pengaturan**
  — catatan: akun itu tanpa kredit untuk model berbayar, dan kadang membalas
  HTTP 200 tetapi body `{"error":…}` (lapisan retry di `openai.ts` sudah
  menangani itu).

## Engine transkripsi

| Engine | Sumber | Syarat |
|---|---|---|
| `onnx` (default) | lokal, `@huggingface/transformers` | model diunduh sekali; `WHISPER_ONNX_MODEL` (default `whisper-medium_timestamped`), `WHISPER_ONNX_DTYPE=q8` |
| `audiocpp` | server `AUDIOCPP_SERVER` (`:8080`) | **server harus punya model ASR terdaftar** — instalasi audio.cpp bawaan hanya mendaftarkan model TTS (`omnivoice`), jadi `AUDIOCPP_MODEL` (mis. `whisper-large-v3`) akan 500 "unknown model id" sampai kamu mendaftarkan model ASR di `server.json` audio.cpp |

`WHISPER_LANGUAGE=id` **wajib** dibiarkan sesuai bahasa video — transformers.js
tidak auto-detect bahasa (default-nya `en`).

## Alur pipeline & kebijakan SFX

1. `probe` → `extract-audio` (WAV 16k) → `transcribe` (word-level)
2. `visual` — frame tiap ~dtk → VLM → momen (cut/zoom/ledakan/dst)
3. `manifest` — LLM menyusun beat dari transkrip + momen + prompt
4. `pick` — RAG (embedding lokal `paraphrase-multilingual-MiniLM-L12-v2`,
   fallback skor token) kandidat per beat → LLM memilih SFX + anchor →
   validasi kepadatan: `SFX_MIN_GAP_SEC` (default 5 dtk), `SFX_MAX_PER_BEAT` (1),
   impact ditempatkan `RENDER_LEAD_MS` (−120 ms) sebelum momen (precedence
   manusia), dikoreksi `onset_ms` hasil analisis audio.
5. `render` — filter_complex: dialog `asplit` → sidechain auto-duck, tiap SFX
   `adelay`+`volume`, bus `amix normalize=0` → `apad/atrim` → campur final.

Semua cue punya `reason` yang bisa dicek di UI; `cue_list.json` tersimpan per job.

## Skrip

```bash
npm test               # vitest: util, filter graph, segmen, normalisasi kata
npm run typecheck      # tsc backend + studio
npx tsx scripts/smoke.ts   # uji API/library in-process
npx tsx scripts/e2e.ts     # uji pipeline penuh (TTS → video → job → verifikasi)
```

## Struktur

```
data/        runtime: autosfx.db (SQLite), sfx/, uploads/, output/jobs/<id>/, settings.json
src/         backend TS (server, pipeline, transcribe, visual, manifest, picker, render)
studio/      UI Vite + React (tema studio gelap)
scripts/     smoke & e2e
tests/       vitest
NOTES.txt    catatan keputusan desain (baca dulu sebelum ubah perilaku)
```
