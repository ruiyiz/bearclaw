/**
 * Embedding provider for vector retrieval.
 *
 * Uses OpenAI's HTTP API (no SDK dependency). When OPENAI_API_KEY is unset
 * or a request fails, returns null so callers fall back to FTS5-only.
 */

import { EMBEDDING_DIMS, EMBEDDING_MODEL, OPENAI_API_KEY } from '../config.js';
import { logger } from '../logger.js';

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const BATCH_SIZE = 64;

let warned = false;

function warnOnce(): void {
  if (!warned) {
    warned = true;
    logger.warn('OPENAI_API_KEY not set; vector retrieval disabled');
  }
}

async function callOpenAI(inputs: string[]): Promise<Float32Array[] | null> {
  if (!OPENAI_API_KEY) {
    warnOnce();
    return null;
  }

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: inputs,
        dimensions: EMBEDDING_DIMS,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: text.slice(0, 300) },
        'OpenAI embeddings request failed',
      );
      return null;
    }

    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => Float32Array.from(d.embedding));
  } catch (err) {
    logger.warn({ err }, 'OpenAI embeddings call threw');
    return null;
  }
}

export async function embed(text: string): Promise<Float32Array | null> {
  const r = await embedBatch([text]);
  return r ? r[0] : null;
}

export async function embedBatch(
  texts: string[],
): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const r = await callOpenAI(batch);
    if (!r) return null;
    results.push(...r);
  }
  return results;
}

export function isEmbeddingAvailable(): boolean {
  return !!OPENAI_API_KEY;
}
