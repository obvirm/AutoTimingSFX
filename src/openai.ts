import { getSettings } from './config.js';
import { parseJsonLoose } from './util.js';

/** Parse respons gateway: JSON biasa, atau SSE (beberapa gateway selalu stream). */
function parseResponseBody(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    /* bukan JSON polos → coba SSE */
  }
  if (text.includes('data:')) {
    let content = '';
    let last: any = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        last = j;
        const delta = j?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') content += delta.content;
      } catch {
        /* potongan tidak utuh → abaikan */
      }
    }
    if (last) {
      if (content) {
        last.choices[0].message = { role: 'assistant', content };
      }
      return last;
    }
  }
  throw new Error(`respons bukan JSON/SSE: ${text.slice(0, 200)}`);
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<any> {
  const s = getSettings();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status} ${url}: ${txt.slice(0, 400)}`);
  }
  return parseResponseBody(await res.text());
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string | any[];
}

const ATTEMPTS_PER_MODEL = 4;

/**
 * Kirim request chat dengan retry tahan-banting + rotasi model cadangan.
 * Kasus yang ditangani: gateway kadang balas HTTP 200 tapi body {"error":...}
 * (upstream_error), 429 rate_limited, konten kosong, dan penolakan
 * response_format/max_tokens (drop parameter lalu lanjut).
 * Setelah ATTEMPTS_PER_MODEL percobaan gagal → lanjut ke LLM_FALLBACK_MODELS.
 * 401/402/403/404 pada suatu model → langsung ke model berikutnya.
 */
async function chatComplete(
  body: Record<string, unknown>,
  timeoutMs: number,
  opts: { fallback?: boolean } = {}
): Promise<any> {
  const s = getSettings();
  const url = `${s.OPENAI_BASE_URL}/chat/completions`;
  const primary = String(body.model ?? s.MODEL_NAME);
  const candidates =
    opts.fallback === false
      ? [primary]
      : [
          primary,
          ...s.LLM_FALLBACK_MODELS.split(',')
            .map((m) => m.trim())
            .filter((m) => m && m !== primary),
        ];
  let lastErr = 'tidak diketahui';

  for (const model of candidates) {
    let dropMaxTokens = false;
    let dropResponseFormat = false;
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      const b: Record<string, unknown> = { ...body, model, stream: false };
      if (dropMaxTokens) delete b.max_tokens;
      if (dropResponseFormat) delete b.response_format;
      let nextModel = false;
      try {
        const j = await postJson(url, b, timeoutMs);
        const msg = j?.choices?.[0]?.message;
        const content = msg?.content;
        if (j?.error) {
          lastErr = `[${model}] ${(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 300)}`;
          if (/payment_required|forbidden|plan does not|not found/i.test(lastErr)) nextModel = true;
        } else if (typeof content === 'string' && content.length > 0) {
          if (model !== primary) console.log(`[llm] ${primary} gagal, fallback → ${model} OK`);
          return j;
        } else if (msg?.reasoning) {
          lastErr = `[${model}] konten kosong (reasoning ada tapi content kosong)`;
        } else {
          lastErr = `[${model}] konten kosong`;
        }
      } catch (e) {
        lastErr = `[${model}] ${(e as Error).message}`;
        if (/max_tokens|max_completion_tokens/i.test(lastErr)) dropMaxTokens = true;
        else if (/response_format/i.test(lastErr)) dropResponseFormat = true;
        else if (/HTTP (401|402|403|404)/.test(lastErr)) nextModel = true;
        // 408/429/5xx/timeout → retry model yang sama
      }
      if (nextModel) break;
      if (attempt < ATTEMPTS_PER_MODEL) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`LLM gagal di ${candidates.length} model: ${lastErr}`);
}

/** Chat completion (OpenAI-compatible). */
export async function chat(
  messages: ChatMsg[],
  opts: { model?: string; json?: boolean; temperature?: number; timeoutMs?: number; maxTokens?: number } = {}
): Promise<string> {
  const s = getSettings();
  const body: Record<string, unknown> = {
    model: opts.model ?? s.MODEL_NAME,
    messages,
    temperature: opts.temperature ?? 0.3,
    // model reasoning (nemotron dsb) menghabiskan token utk berpikir →
    // beri ruang besar supaya content utama tidak kosong
    max_tokens: opts.maxTokens ?? 8192,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  const j = await chatComplete(body, opts.timeoutMs ?? 180_000);
  return j.choices[0].message.content as string;
}

export async function chatJson<T>(messages: ChatMsg[], opts: { model?: string; timeoutMs?: number } = {}): Promise<T> {
  const raw = await chat(messages, { ...opts, json: false });
  return parseJsonLoose<T>(raw);
}

/** Kirim segmen video MP4 (base64, termasuk audio) ke VLM. */
export async function chatVideo(
  text: string,
  b64Mp4: string,
  opts: { model?: string; timeoutMs?: number } = {}
): Promise<string> {
  const s = getSettings();
  const content: any[] = [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: `data:video/mp4;base64,${b64Mp4}` } },
  ];
  const body: Record<string, unknown> = {
    model: opts.model ?? s.VLM_MODEL,
    messages: [{ role: 'user', content }],
    temperature: 0.2,
    max_tokens: 4096,
  };
  // tanpa rotasi fallback: model teks-cadangan bisa membuang media diam-diam
  const j = await chatComplete(body, opts.timeoutMs ?? 300_000, { fallback: false });
  return j.choices[0].message.content as string;
}
