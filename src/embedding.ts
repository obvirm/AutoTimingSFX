import { getSettings } from './config.js';

/**
 * Embedding untuk retrieval SFX.
 * - Default: MODEL LOKAL via @huggingface/transformers (offline, gratis).
 * - Kalau EMBEDDING_MODEL gaya OpenAI (tidak mengandung '/'), coba API dulu,
 *   gagal → fallback lokal.
 * - Semua gagal → null (pencarian fallback ke LIKE berbasis token).
 */
let extractorPromise: Promise<any> | null = null;
const LOCAL_FALLBACK_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

function looksLikeHfId(model: string): boolean {
  return model.includes('/');
}

async function getExtractor(model: string): Promise<any> {
  if (extractorPromise) return extractorPromise;
  const { pipeline } = await import('@huggingface/transformers');
  extractorPromise = (async () => {
    console.log(`[embed] memuat model lokal ${model}...`);
    const t0 = Date.now();
    const ex = await pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu' });
    console.log(`[embed] model siap dalam ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return ex;
  })();
  try {
    return await extractorPromise;
  } catch (e) {
    extractorPromise = null;
    throw e;
  }
}

async function embedLocal(texts: string[], model: string): Promise<Float32Array[]> {
  const m = looksLikeHfId(model) ? model : LOCAL_FALLBACK_MODEL;
  const ex = await getExtractor(m);
  const out: Float32Array[] = [];
  for (const t of texts) {
    const ten = await ex(t, { pooling: 'mean', normalize: true });
    out.push(Float32Array.from(ten.data as ArrayLike<number>));
  }
  return out;
}

async function embedApi(texts: string[], model: string): Promise<Float32Array[] | null> {
  const s = getSettings();
  if (!s.OPENAI_API_KEY || !s.OPENAI_BASE_URL) return null;
  try {
    const res = await fetch(`${s.OPENAI_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const data = j?.data as { index: number; embedding: number[] }[] | undefined;
    if (!Array.isArray(data)) return null;
    return [...data]
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding));
  } catch {
    return null;
  }
}

/** Embedding teks → Float32Array[] atau null kalau semua backend gagal. */
export async function embed(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const model = getSettings().EMBEDDING_MODEL;
  try {
    if (!looksLikeHfId(model)) {
      const viaApi = await embedApi(texts, model);
      if (viaApi) return viaApi;
    }
    return await embedLocal(texts, model);
  } catch (e) {
    console.warn('[embed] gagal:', (e as Error).message);
    return null;
  }
}

/** Model yang benar-benar dipakai untuk vektor (untuk penyimpanan). */
export function activeEmbeddingModel(): string {
  const m = getSettings().EMBEDDING_MODEL;
  return looksLikeHfId(m) ? m : LOCAL_FALLBACK_MODEL;
}

/** Skor fallback berbasis token (kalau embedding tidak tersedia). */
export function tokenScore(query: string, text: string): number {
  const q = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  if (q.length === 0) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const t of q) if (hay.includes(t)) hit++;
  return hit / q.length;
}
