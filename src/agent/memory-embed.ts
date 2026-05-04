/**
 * Bridge between the chunk indexer and the embedding provider.
 * Embeds any chunks that lack an embedding, in batches.
 */

import {
  getChunksMissingEmbeddings,
  isVectorAvailable,
  setChunkEmbedding,
} from '../db.js';
import { logger } from '../logger.js';
import { embedBatch, isEmbeddingAvailable } from './embedder.js';

let inFlight: Promise<void> | null = null;

/**
 * Embed any chunks missing embeddings. Idempotent and safe to call repeatedly.
 * If a previous call is still in flight, returns that same promise.
 */
export function embedPendingChunks(maxBatches = 4): Promise<void> {
  if (!isVectorAvailable() || !isEmbeddingAvailable()) return Promise.resolve();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      let batches = 0;
      while (batches < maxBatches) {
        const pending = getChunksMissingEmbeddings(64);
        if (pending.length === 0) break;
        const vectors = await embedBatch(pending.map((c) => c.content));
        if (!vectors) break;
        for (let i = 0; i < pending.length; i++) {
          setChunkEmbedding(pending[i].id, vectors[i]);
        }
        batches++;
        logger.debug({ count: pending.length }, 'Embedded chunk batch');
      }
    } catch (err) {
      logger.warn({ err }, 'Embedding pending chunks failed');
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
