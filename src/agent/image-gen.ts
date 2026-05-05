/**
 * OpenAI image generation client.
 * Saves generated image to disk and returns the local path so the agent
 * can attach it via send_message (media_type="image", file_path=...).
 */
import fs from 'fs';
import path from 'path';
import { OPENAI_API_KEY } from '../config.js';

export interface ImageGenArgs {
  prompt: string;
  model?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  background?: 'transparent' | 'opaque' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  outputDir: string;
}

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

export async function generateImage(args: ImageGenArgs): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const body: Record<string, unknown> = {
    model: args.model || 'gpt-image-2',
    prompt: args.prompt,
    n: 1,
  };
  if (args.size) body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.background) body.background = args.background;
  if (args.outputFormat) body.output_format = args.outputFormat;

  // Bound the upstream call so a stuck connection fails fast instead of
  // burning the agent's full timeout budget (default 5 min).
  const genTimeoutMs = parseInt(
    process.env.IMAGE_GEN_TIMEOUT_MS ?? '180000',
    10,
  );

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(genTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `OpenAI image generation timed out after ${genTimeoutMs}ms. Try quality="medium" or "low".`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI images API ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as ImagesApiResponse;
  const item = json.data?.[0];
  if (!item) throw new Error('OpenAI images API returned no data');

  let buf: Buffer;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const imgRes = await fetch(item.url, {
      signal: AbortSignal.timeout(60000),
    });
    if (!imgRes.ok) {
      throw new Error(`Failed to download image: ${imgRes.status}`);
    }
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error('Image response missing both b64_json and url');
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  const ext = args.outputFormat || 'png';
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = path.join(args.outputDir, filename);
  fs.writeFileSync(filepath, buf);
  return filepath;
}
