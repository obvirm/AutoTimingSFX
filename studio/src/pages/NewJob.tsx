import { useRef, useState } from 'react';
import { api } from '../api';

export function NewJob() {
  const [file, setFile] = useState<File | null>(null);
  const [videoPath, setVideoPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState('onnx');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const inRef = useRef<HTMLInputElement>(null);

  const upload = async (f: File) => {
    setFile(f);
    setErr('');
    setBusy(true);
    setPhase('mengunggah video…');
    try {
      const r = await api.uploadVideo(f);
      setVideoPath(r.videoPath);
      setPhase('terunggah ✓');
    } catch (e) {
      setErr('upload gagal: ' + (e as Error).message);
      setVideoPath('');
      setPhase('');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!videoPath) return;
    setBusy(true);
    setErr('');
    setPhase('menjalankan pipeline…');
    try {
      const r = await api.run({ videoPath, prompt, engine });
      location.hash = `#/jobs/${r.jobId}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
      setPhase('');
    }
  };

  return (
    <div>
      <h1>Job Baru</h1>
      <p className="sub">
        Satu shot: video → transkrip (Whisper) → visual (VLM) → manifest beat → picker SFX (RAG) → render FFmpeg.
      </p>
      {err && <div className="errbox">{err}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>1 · Video</h2>
        <div
          className={'dropzone' + (over ? ' over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer.files[0]) void upload(e.dataTransfer.files[0]);
          }}
          onClick={() => inRef.current?.click()}
        >
          {busy && phase.startsWith('mengunggah')
            ? 'Mengunggah…'
            : file
              ? `✓ ${file.name} — ${videoPath ? 'siap' : 'gagal'}`
              : 'Tarik video (mp4/mov/mkv) atau klik untuk pilih'}
        </div>
        <input
          ref={inRef}
          className="file"
          type="file"
          accept="video/*"
          onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
        />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>2 · Arahkan</h2>
        <label className="f">
          <span>Prompt (opsional) — nada/hal yang diinginkan</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="mis: video pesta ulang tahun yang ceria, kasih SFX komedi di punchline dan transisi"
          />
        </label>
        <div className="grid3">
          <label className="f">
            <span>Engine transkripsi</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              <option value="onnx">Whisper ONNX (lokal, default)</option>
              <option value="audiocpp">audio.cpp (:8080 — butuh model ASR terdaftar)</option>
            </select>
          </label>
          <label className="f">
            <span>Keypadatan SFX</span>
            <input type="text" disabled value="diatur global di Pengaturan (min gap / max per beat)" />
          </label>
          <label className="f">
            <span>Bahasa transkrip</span>
            <input type="text" disabled value="id (WHISPER_LANGUAGE, di Pengaturan)" />
          </label>
        </div>
        <div className="foot-actions">
          <button className="primary" disabled={!videoPath || busy} onClick={start}>
            {busy ? phase || 'Bekerja…' : 'Jalankan pipeline →'}
          </button>
          <span className="muted small">Estimasi: transkrip lokal + VLM + render tergantung panjang video.</span>
        </div>
      </div>
    </div>
  );
}
