import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Cue, FxCue, JobDetail, SfxRow } from '../types';

const STAGES = [
  ['probe', 'probe'],
  ['analyze', 'analisis VLM'],
  ['manifest', 'manifest'],
  ['pick', 'picker'],
  ['fx', 'efek'],
  ['render', 'render'],
  ['done', 'selesai'],
] as const;

const STAGE_ORDER: string[] = STAGES.map((s) => s[0]);

function stageClass(job: JobDetail, key: string): string {
  if (job.status === 'done') return 'stage done';
  const cur = STAGE_ORDER.indexOf(job.stage);
  const me = STAGE_ORDER.indexOf(key);
  if (me < 0) return 'stage';
  if (job.status === 'running') {
    if (me < cur) return 'stage done';
    if (me === cur) return 'stage now';
    return 'stage';
  }
  if (job.status === 'error' && me <= cur) return me === cur ? 'stage now' : 'stage done';
  return 'stage';
}

function CueEditor({
  jobId,
  cues,
  sfxRows,
  onRerendered,
}: {
  jobId: string;
  cues: Cue[];
  sfxRows: SfxRow[];
  onRerendered: () => void;
}) {
  const [draft, setDraft] = useState<Cue[]>(cues);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setDraft(cues);
    setMsg('');
  }, [cues]);

  const patch = (i: number, k: keyof Cue, v: string) => {
    setDraft((d) =>
      d.map((c, idx) => {
        if (idx !== i) return c;
        const nv: Cue = { ...c };
        if (k === 'anchorT' || k === 'start' || k === 'gain') (nv as any)[k] = Number(v);
        else if (k === 'leadMs') nv.leadMs = Number(v);
        else if (k === 'sfxId') nv.sfxId = Number(v);
        else (nv as any)[k] = v;
        return nv;
      })
    );
  };

  const rerender = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.rerender(
        jobId,
        draft.map((c) => ({ ...c, gain: Math.min(1, Math.max(0, c.gain)) }))
      );
      setMsg('re-render dijalankan — tunggu status kembali done');
      onRerendered();
    } catch (e) {
      setMsg('gagal: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gainDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -60);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Cue list ({draft.length})</strong>
        <div className="row">
          <a className="btn" href={api.artifactUrl(jobId, 'cue_list.json')} download>
            unduh cue_list.json
          </a>
          <button className="primary" disabled={busy} onClick={rerender}>
            {busy ? 'Mengirim…' : 'Simpan & Re-render'}
          </button>
        </div>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {draft.length === 0 && <p className="muted">Tidak ada cue — pipeline memilih tidak ada SFX yang layak.</p>}
      {draft.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>SFX</th>
              <th>mulai (dtk)</th>
              <th>anchor (dtk)</th>
              <th>lead (ms)</th>
              <th>gain (dB)</th>
              <th>tipe</th>
              <th>alasan LLM</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((c, i) => (
              <tr key={c.id || i}>
                <td className="mono">{i + 1}</td>
                <td>
                  <select value={c.sfxId} onChange={(e) => patch(i, 'sfxId', e.target.value)}>
                    {sfxRows.map((s) => (
                      <option key={s.id} value={s.id}>
                        #{s.id} {s.filename}
                      </option>
                    ))}
                    {!sfxRows.some((s) => s.id === c.sfxId) && <option value={c.sfxId}>#{c.sfxId} (terhapus?)</option>}
                  </select>
                </td>
                <td>
                  <input type="number" step="0.01" value={c.start} onChange={(e) => patch(i, 'start', e.target.value)} style={{ width: 90 }} />
                </td>
                <td>
                  <input type="number" step="0.01" value={c.anchorT} onChange={(e) => patch(i, 'anchorT', e.target.value)} style={{ width: 90 }} />
                </td>
                <td>
                  <input type="number" step="10" value={c.leadMs} onChange={(e) => patch(i, 'leadMs', e.target.value)} style={{ width: 80 }} />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.5"
                    value={Number(gainDb(c.gain).toFixed(1))}
                    onChange={(e) => patch(i, 'gain', String(Math.pow(10, Number(e.target.value) / 20)))}
                    style={{ width: 80 }}
                  />
                </td>
                <td>
                  <select value={c.type} onChange={(e) => patch(i, 'type', e.target.value)}>
                    <option value="impact">impact</option>
                    <option value="voice">voice</option>
                    <option value="stinger">stinger</option>
                    <option value="ambience">ambience</option>
                  </select>
                </td>
                <td className="muted small" style={{ maxWidth: 320 }}>
                  {c.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        lead negatif = mulai sebelum momen (aturan precedence impact). gain dalam dB dikonversi ke linear untuk
        filtergraph.
      </p>
    </div>
  );
}

export function JobDetailPage({ id }: { id: string }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [fx, setFx] = useState<FxCue[]>([]);
  const [sfxRows, setSfxRows] = useState<SfxRow[]>([]);
  const [err, setErr] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const j = await api.getJob(id);
      setJob(j);
      setErr('');
      if (j.status === 'done' || typeof j.data?.cueCount === 'number') {
        try {
          const r = await fetch(api.artifactUrl(id, 'cue_list.json'));
          if (r.ok) {
            const j = (await r.json()) as { cues: Cue[]; fx?: FxCue[] };
            setCues(j.cues ?? []);
            setFx(j.fx ?? []);
          }
        } catch {
          /* cue_list belum ada */
        }
      }
      return j;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    void api.listSfx().then(setSfxRows).catch(() => undefined);
    let timer = 0;
    let alive = true;
    const tick = async () => {
      const j = await load();
      if (!alive) return;
      if (j && (j.status === 'running' || j.status === 'queued')) timer = window.setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.events.length]);

  if (err) return <div className="errbox">{err}</div>;
  if (!job) return <p className="muted">Memuat…</p>;

  const running = job.status === 'running' || job.status === 'queued';

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginBottom: 0 }}>Job {job.id.slice(0, 8)}</h1>
        <div className="row">
          <span className={'badge ' + (running ? 'running' : job.status)}>{job.status}</span>
          {running && (
            <button
              className="danger ghost"
              onClick={async () => {
                await api.cancelJob(job.id);
                void load();
              }}
            >
              Batalkan
            </button>
          )}
        </div>
      </div>
      <p className="sub">
        {job.video_name} · {job.created_at} {job.prompt && <> · “{job.prompt}”</>}
      </p>

      {job.error && <div className="errbox">{job.error}</div>}

      <div className="card">
        <div className="stages">
          {STAGES.map(([key, label]) => (
            <span key={key} className={stageClass(job, key)}>
              {label}
            </span>
          ))}
        </div>
        <div className="log" ref={logRef}>
          {job.events.map((e, i) => (
            <div key={i} className={e.level === 'error' ? 'e' : e.level === 'warn' ? 'w' : 'i'}>
              {e.ts.slice(11, 19)} {e.message}
            </div>
          ))}
          {job.events.length === 0 && <div className="i">belum ada event</div>}
        </div>
      </div>

      <h2>Hasil</h2>
      <div className="card video-box">
        {job.status === 'done' ? (
          <video controls src={api.artifactUrl(job.id, 'final.mp4')} />
        ) : (
          <p className="muted">{running ? 'Masih diproses… video muncul setelah selesai.' : 'Tidak ada hasil (job gagal/dibatalkan).'}</p>
        )}
        {(cues.length > 0 || fx.length > 0) && (
          <div className="timeline">
            {(() => {
              const span = Math.max(6, ...cues.map((c) => c.start), ...fx.map((f) => f.start)) * 1.15;
              return [
                ...cues.map((c, i) => (
                  <span
                    key={`c${i}`}
                    className="mark"
                    data-t={`${c.start.toFixed(2)}s`}
                    style={{ left: `${Math.min(97, (c.start / span) * 100)}%` }}
                  />
                )),
                ...fx.map((f, i) => (
                  <span
                    key={`f${i}`}
                    className="mark"
                    data-t={f.effect}
                    title={`${f.kind} ${f.start.toFixed(2)}-${f.end.toFixed(2)}s`}
                    style={{ left: `${Math.min(97, (f.start / span) * 100)}%`, opacity: 0.55 }}
                  />
                )),
              ];
            })()}
            <span className="ruler" />
          </div>
        )}
        <div className="foot-actions">
          <a className="btn" href={api.artifactUrl(job.id, 'events.json')} download>
            events.json
          </a>
          <a className="btn" href={api.artifactUrl(job.id, 'manifest.json')} download>
            manifest.json
          </a>
          <a className="btn" href={api.artifactUrl(job.id, 'cue_list.json')} download>
            cue_list.json
          </a>
        </div>
      </div>

      {fx.length > 0 && (
        <>
          <h2>Efek ({fx.length})</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>jenis</th>
                  <th>efek</th>
                  <th>waktu</th>
                  <th>intensitas</th>
                  <th>teks/warna</th>
                  <th>alasan LLM</th>
                </tr>
              </thead>
              <tbody>
                {fx.map((f, i) => (
                  <tr key={f.id || i}>
                    <td className="mono">{i + 1}</td>
                    <td>
                      <span className={'badge ' + f.kind}>{f.kind}</span>
                    </td>
                    <td className="mono">{f.effect}</td>
                    <td className="mono">
                      {f.start.toFixed(2)}–{f.end.toFixed(2)}s
                    </td>
                    <td className="mono">{f.intensity.toFixed(2)}</td>
                    <td className="small">
                      {f.text ? `“${f.text}” ` : ''}
                      {f.color || ''}
                    </td>
                    <td className="muted small" style={{ maxWidth: 320 }}>
                      {f.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              vfx di-render oleh sidecar fframes di atas footage asli; afx (echo/reverb) difilter FFmpeg pada
              dialog. Waktu efek dipertahankan saat re-render SFX.
            </p>
          </div>
        </>
      )}

      {cues.length > 0 && (
        <>
          <h2>Edit cue → re-render</h2>
          <CueEditor jobId={job.id} cues={cues} sfxRows={sfxRows} onRerendered={() => void load()} />
        </>
      )}
    </div>
  );
}
