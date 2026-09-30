import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SettingsMap } from '../types';

const GROUPS: { title: string; keys: { k: string; label: string; hint?: string; secret?: boolean }[] }[] = [
  {
    title: 'Gateway LLM',
    keys: [
      { k: 'OPENAI_BASE_URL', label: 'Base URL' },
      { k: 'OPENAI_API_KEY', label: 'API Key', secret: true },
      { k: 'MODEL_NAME', label: 'Model teks (manifest & picker)' },
      { k: 'VLM_MODEL', label: 'Model analisis (video+audio)', hint: 'wajib dukung input video+audio — Gemini, GPT-4o, dll' },
      {
        k: 'LLM_FALLBACK_MODELS',
        label: 'Model cadangan (koma)',
        hint: 'dipakai otomatis kalau model utama gagal',
      },
      { k: 'EMBEDDING_MODEL', label: 'Model embedding lokal' },
    ],
  },
  {
    title: 'Kebijakan SFX',
    keys: [
      { k: 'SFX_MIN_GAP_SEC', label: 'Jarak minimum antar cue (dtk)' },
      { k: 'SFX_MAX_PER_BEAT', label: 'Maks SFX per beat' },
      { k: 'RENDER_LEAD_MS', label: 'Lead default impact (ms, negatif=sebelum)' },
    ],
  },
];

export function SettingsPage() {
  const [form, setForm] = useState<SettingsMap>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api
      .settings()
      .then(setForm)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api.saveSettings(form);
      setMsg('tersimpan ✓');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>Pengaturan</h1>
      <p className="sub">Disimpan ke data/settings.json (menang atas .env). API key ditampilkan tersamar.</p>
      {err && <div className="errbox">{err}</div>}
      {msg && <div className="okbox">{msg}</div>}

      {GROUPS.map((g) => (
        <div className="card" key={g.title}>
          <h2 style={{ marginTop: 0 }}>{g.title}</h2>
          <div className="grid2">
            {g.keys.map(({ k, label, hint, secret }) => (
              <label className="f" key={k}>
                <span>
                  {label} <span className="mono muted">({k})</span>
                </span>
                <input
                  type={secret ? 'password' : 'text'}
                  value={form[k] ?? ''}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                />
                {hint && <span className="muted small">{hint}</span>}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="foot-actions">
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? 'Menyimpan…' : 'Simpan pengaturan'}
        </button>
      </div>
    </div>
  );
}
