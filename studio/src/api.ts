import type { Cue, JobDetail, JobSummary, SearchHit, SettingsMap, SfxRow } from './types';

async function jq<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let m = '';
    try {
      m = ((await r.json()) as { error?: string }).error ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(m || `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

function body(v: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) };
}

export const api = {
  settings: () => jq<SettingsMap>('/api/settings'),
  saveSettings: (patch: SettingsMap) => jq<{ ok: true }>('/api/settings', body(patch)),

  listSfx: () => jq<SfxRow[]>('/api/sfx'),
  searchSfx: (q: string) => jq<SearchHit[]>(`/api/sfx/search?q=${encodeURIComponent(q)}`),
  saveSfx: (id: number, patch: { description?: string; tags?: string[]; category?: string }) =>
    jq<SfxRow>(`/api/sfx/${id}`, body(patch)),
  deleteSfx: (id: number) => jq<{ ok: true }>(`/api/sfx/${id}`, { method: 'DELETE' }),
  importSfx: async (file: File): Promise<SfxRow> => {
    const r = await fetch(`/api/sfx/import?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    });
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
    return (await r.json()) as SfxRow;
  },
  sfxFileUrl: (id: number) => `/api/sfx/${id}/file`,

  uploadVideo: async (file: File): Promise<{ videoPath: string; name: string }> => {
    const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
    return (await r.json()) as { videoPath: string; name: string };
  },
  run: (p: { videoPath: string; prompt: string; engine: string; options?: Record<string, string> }) =>
    jq<{ jobId: string }>('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),

  listJobs: () => jq<JobSummary[]>('/api/jobs'),
  getJob: (id: string) => jq<JobDetail>(`/api/jobs/${id}`),
  cancelJob: (id: string) => jq<{ ok: true }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  rerender: (id: string, cues: Cue[]) => jq<{ ok: true }>(`/api/jobs/${id}/rerender`, body({ cues })),
  artifactUrl: (id: string, name: string) => `/api/jobs/${id}/artifact/${name}`,
};
