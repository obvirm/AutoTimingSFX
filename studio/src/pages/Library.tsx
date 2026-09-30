import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SfxRow } from '../types';

function Waveform({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stop = false;
    (async () => {
      const cv = ref.current;
      if (!cv) return;
      try {
        const ab = await (await fetch(url)).arrayBuffer();
        if (stop) return;
        const ac = new AudioContext();
        const buf = await ac.decodeAudioData(ab);
        if (stop) return;
        const data = buf.getChannelData(0);
        const w = (cv.width = cv.clientWidth * 2);
        const h = cv.height;
        const step = Math.max(1, Math.floor(data.length / w));
        const g = cv.getContext('2d')!;
        g.clearRect(0, 0, w, h);
        const grad = g.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, '#7c3aed');
        grad.addColorStop(1, '#38bdf8');
        g.fillStyle = grad;
        for (let x = 0; x < w; x++) {
          let peak = 0;
          for (let i = 0; i < step; i++) {
            const v = Math.abs(data[x * step + i] ?? 0);
            if (v > peak) peak = v;
          }
          const bh = Math.max(1, peak * h);
          g.fillRect(x, (h - bh) / 2, 1, bh);
        }
        ac.close();
      } catch {
        /* audio tidak ter-decode → biarkan kosong */
      }
    })();
    return () => {
      stop = true;
    };
  }, [url]);
  return <canvas ref={ref} className="wave" />;
}

function Editor({ row, onSaved, onDeleted }: { row: SfxRow; onSaved: () => void; onDeleted: () => void }) {
  const [desc, setDesc] = useState(row.description);
  const [tags, setTags] = useState(row.tags);
  const [category, setCategory] = useState(row.category);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setDesc(row.description);
    setTags(row.tags);
    setCategory(row.category);
    setMsg('');
  }, [row.id]);

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.saveSfx(row.id, {
        description: desc,
        category,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setMsg('tersimpan ✓ (embedding & indeks ikut diperbarui)');
      onSaved();
    } catch (e) {
      setMsg('gagal: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm(`Hapus SFX #${row.id} ${row.filename}?`)) return;
    await api.deleteSfx(row.id);
    onDeleted();
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <span className="pill">#{row.id}</span>{' '}
          <strong>{row.filename}</strong>{' '}
          <span className="muted mono small">
            {(row.duration_ms / 1000).toFixed(2)}s · {row.lufs.toFixed(1)} LUFS · onset {row.onset_ms}ms · peak{' '}
            {row.peak_db.toFixed(1)}dB
          </span>
        </div>
        <div className="row">
          <audio controls src={api.sfxFileUrl(row.id)} preload="none" />
          <button className="danger ghost" onClick={del}>
            Hapus
          </button>
        </div>
      </div>
      <div style={{ margin: '10px 0' }}>
        <Waveform url={api.sfxFileUrl(row.id)} />
      </div>
      <label className="f">
        <span>Deskripsi (DITULIS MANUAL — inilah yang dicari RAG)</span>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="mis: whoosh cepat komedi, cocok utk transisi/zoom" />
      </label>
      <div className="grid2">
        <label className="f">
          <span>Kategori</span>
          <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="impact / ui / ambience / vocal" />
        </label>
        <label className="f">
          <span>Tags (koma)</span>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="komedi, transisi, cepat" />
        </label>
      </div>
      <div className="foot-actions">
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? 'Menyimpan…' : 'Simpan deskripsi'}
        </button>
        {msg && <span className={msg.includes('gagal') ? 'muted' : 'muted'}>{msg}</span>}
      </div>
    </div>
  );
}

export function Library() {
  const [rows, setRows] = useState<SfxRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const videoRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      setRows(await api.listSfx());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const doImport = async (files: FileList | File[]) => {
    setBusy(true);
    setErr('');
    try {
      let last: SfxRow | null = null;
      for (const f of Array.from(files)) last = await api.importSfx(f);
      await refresh();
      if (last) setSelected(last.id);
    } catch (e) {
      setErr('import gagal: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sel = rows.find((r) => r.id === selected) ?? null;

  return (
    <div>
      <h1>Library SFX</h1>
      <p className="sub">
        Impor MP3/WAV → dengarkan → tulis deskripsi sendiri (RAG memakai deskripsi ini, bukan AI mengarang).
      </p>
      {err && <div className="errbox">{err}</div>}

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
          void doImport(e.dataTransfer.files);
        }}
        onClick={() => videoRef.current?.click()}
      >
        {busy ? 'Menganalisis audio… (duration/LUFS/onset)' : 'Tarik file SFX ke sini atau klik untuk pilih file'}
      </div>
      <input
        ref={videoRef}
        className="file"
        type="file"
        accept="audio/*"
        multiple
        onChange={(e) => e.target.files && void doImport(e.target.files)}
      />

      <h2>{rows.length} SFX</h2>
      {rows.length === 0 && <div className="card muted">Belum ada SFX. Impor dulu di atas.</div>}
      {rows.map((r) => (
        <div className="sfx-item" key={r.id}>
          <div className="id">{r.id}</div>
          <div>
            <strong>{r.filename}</strong>{' '}
            <span className="muted small mono">
              {(r.duration_ms / 1000).toFixed(2)}s · onset {r.onset_ms}ms
            </span>
            <div className="muted small">{r.description || '— belum ada deskripsi —'}</div>
            {r.tags && (
              <div className="tags">
                {r.tags
                  .split(',')
                  .filter(Boolean)
                  .map((t, i) => (
                    <span className="tag" key={i}>
                      {t}
                    </span>
                  ))}
              </div>
            )}
          </div>
          <button onClick={() => setSelected(r.id)}>{selected === r.id ? 'Terbuka' : 'Edit'}</button>
        </div>
      ))}

      {sel && (
        <>
          <h2>Edit SFX #{sel.id}</h2>
          <Editor row={sel} onSaved={refresh} onDeleted={() => { setSelected(null); void refresh(); }} />
        </>
      )}
    </div>
  );
}
