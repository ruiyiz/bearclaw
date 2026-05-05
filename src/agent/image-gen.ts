/**
 * Image generation client with provider routing.
 *
 * Routing by `model`:
 *   - "gpt-image-*" / unset → OpenAI Images API
 *   - "gemini-*" / "nano-banana" → Google Generative Language API
 *
 * Saves the generated image to disk and returns the local path so the agent
 * can attach it via send_message (media_type="image", file_path=...).
 */
import fs from 'fs';
import path from 'path';
import { GOOGLE_API_KEY, OPENAI_API_KEY } from '../config.js';

export interface ImageGenArgs {
  prompt: string;
  model?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  background?: 'transparent' | 'opaque' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  outputDir: string;
}

const NANO_BANANA_MODEL = 'gemini-2.5-flash-image';
const NANO_BANANA_2_MODEL = 'gemini-3.1-flash-image-preview';
const NANO_BANANA_PRO_MODEL = 'gemini-3-pro-image-preview';

const GEMINI_ALIASES: Record<string, string> = {
  'nano-banana': NANO_BANANA_MODEL,
  'nano-banana-1': NANO_BANANA_MODEL,
  'nano-banana-2': NANO_BANANA_2_MODEL,
  'nano-banana-pro': NANO_BANANA_PRO_MODEL,
};

function resolveModel(model: string | undefined): {
  provider: 'openai' | 'gemini';
  modelId: string;
} {
  const m = (model || '').trim();
  if (!m) return { provider: 'openai', modelId: 'gpt-image-2' };
  const alias = GEMINI_ALIASES[m];
  if (alias) return { provider: 'gemini', modelId: alias };
  if (m.startsWith('gemini')) return { provider: 'gemini', modelId: m };
  return { provider: 'openai', modelId: m };
}

function getGenTimeoutMs(): number {
  return parseInt(process.env.IMAGE_GEN_TIMEOUT_MS ?? '180000', 10);
}

function writeImage(
  buf: Buffer,
  outputDir: string,
  outputFormat: string | undefined,
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const ext = outputFormat || 'png';
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, buf);
  return filepath;
}

export async function generateImage(args: ImageGenArgs): Promise<string> {
  const { provider, modelId } = resolveModel(args.model);
  if (provider === 'gemini') {
    return generateImageGemini({ ...args, model: modelId });
  }
  return generateImageOpenAI({ ...args, model: modelId });
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

interface OpenAIImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

async function generateImageOpenAI(args: ImageGenArgs): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

  const body: Record<string, unknown> = {
    model: args.model,
    prompt: args.prompt,
    n: 1,
  };
  if (args.size) body.size = args.size;
  if (args.quality) body.quality = args.quality;
  if (args.background) body.background = args.background;
  if (args.outputFormat) body.output_format = args.outputFormat;

  const genTimeoutMs = getGenTimeoutMs();
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

  const json = (await res.json()) as OpenAIImagesApiResponse;
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

  return writeImage(buf, args.outputDir, args.outputFormat);
}

// ─── Gemini (nano-banana) ────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
}

function geminiExtToFormat(mime: string | undefined): string {
  if (!mime) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpeg';
  if (mime.includes('webp')) return 'webp';
  return 'png';
}

async function generateImageGemini(args: ImageGenArgs): Promise<string> {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not set');

  const modelId = args.model || NANO_BANANA_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelId,
  )}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: args.prompt }] }],
  };

  const genTimeoutMs = getGenTimeoutMs();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GOOGLE_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(genTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Gemini image generation timed out after ${genTimeoutMs}ms.`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini images API ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as GeminiResponse;

  if (json.promptFeedback?.blockReason) {
    throw new Error(
      `Gemini blocked prompt: ${json.promptFeedback.blockReason}`,
    );
  }

  const parts = json.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error('Gemini response contained no parts');
  }

  let inline: { mime?: string; data: string } | null = null;
  for (const p of parts) {
    const camel = p.inlineData;
    const snake = p.inline_data;
    const data = camel?.data ?? snake?.data;
    if (data) {
      inline = {
        mime: camel?.mimeType ?? snake?.mime_type,
        data,
      };
      break;
    }
  }
  if (!inline) {
    const text = parts
      .map((p) => p.text)
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);
    throw new Error(
      `Gemini returned no image data${text ? ` (text: ${text})` : ''}`,
    );
  }

  const buf = Buffer.from(inline.data, 'base64');
  const fmt = args.outputFormat || geminiExtToFormat(inline.mime);
  return writeImage(buf, args.outputDir, fmt);
}
