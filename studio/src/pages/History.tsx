import { useEffect, useState } from 'react';
import { api } from '../api';
import type { JobSummary } from '../types';

export function History() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [err, setErr] = useState('');

  const load = () => api.listJobs().then((j) => setJobs(j.reverse())).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <h1>Riwayat Job</h1>
      <p className="sub">Klik baris untuk membuka detail, log, video hasil, dan editor cue.</p>
      {err && <div className="errbox">{err}</div>}
      <div className="card">
        {jobs.length === 0 && <p className="muted">Belum ada job. Mulai dari “Job Baru”.</p>}
        {jobs.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Video</th>
                <th>Engine</th>
                <th>Prompt</th>
                <th>Dibuat</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} style={{ cursor: 'pointer' }} onClick={() => (location.hash = `#/jobs/${j.id}`)}>
                  <td>
                    <span className={'badge ' + j.status}>{j.status}</span>{' '}
                    {j.status === 'running' && <span className="muted small">{j.stage}</span>}
                  </td>
                  <td>
                    {j.video_name}
                    <div className="muted small mono">{j.id.slice(0, 8)}</div>
                  </td>
                  <td className="mono small">{j.engine}</td>
                  <td className="muted small" style={{ maxWidth: 300 }}>
                    {j.prompt || '—'}
                  </td>
                  <td className="mono small">{j.created_at.slice(0, 19).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
