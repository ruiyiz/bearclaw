/**
 * Voice message transcription using local Whisper or ElevenLabs STT
 *
 * Set STT_PROVIDER=elevenlabs to use ElevenLabs (requires ELEVENLABS_API_KEY).
 * Default is local Whisper.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

const STT_PROVIDER = process.env.STT_PROVIDER || 'whisper';
const WHISPER_PATH = process.env.WHISPER_PATH || '/Users/ruiyiz/.local/bin/whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const TEMP_DIR = path.join(STORE_DIR, 'audio_temp');

fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function transcribeAudio(
  buffer: Buffer,
  audioId?: string,
): Promise<string | null> {
  if (STT_PROVIDER === 'elevenlabs') {
    return transcribeWithElevenLabs(buffer);
  }
  return transcribeWithWhisper(buffer, audioId);
}

async function transcribeWithElevenLabs(buffer: Buffer): Promise<string | null> {
  if (!ELEVENLABS_API_KEY) {
    logger.error('ELEVENLABS_API_KEY not set, cannot use ElevenLabs STT');
    return null;
  }

  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'audio.ogg');
    form.append('model_id', ELEVENLABS_STT_MODEL);

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.error({ status: response.status, errText, ms: Date.now() - t0 }, 'ElevenLabs STT failed');
      return null;
    }

    const data = await response.json() as { text?: string };
    const transcription = data.text?.trim() || null;
    if (transcription) {
      logger.info({ length: transcription.length, ms: Date.now() - t0 }, 'Audio transcribed via ElevenLabs');
    }
    return transcription;
  } catch (err) {
    logger.error({ err, ms: Date.now() - t0 }, 'ElevenLabs STT error');
    return null;
  }
}

async function transcribeWithWhisper(buffer: Buffer, audioId?: string): Promise<string | null> {
  const t0 = Date.now();
  try {
    const id = audioId || `audio_${Date.now()}`;
    const oggPath = path.join(TEMP_DIR, `${id}.ogg`);
    const wavPath = path.join(TEMP_DIR, `${id}.wav`);

    fs.writeFileSync(oggPath, buffer);

    try {
      await execFileAsync('ffmpeg', [
        '-i', oggPath,
        '-ar', '16000',
        '-ac', '1',
        '-y',
        wavPath,
      ]);
    } catch (err) {
      logger.error({ err }, 'Failed to convert audio to WAV');
      cleanup(oggPath, wavPath);
      return null;
    }

    const outputDir = TEMP_DIR;
    const { stdout, stderr } = await execFileAsync(WHISPER_PATH, [
      wavPath,
      '--model', WHISPER_MODEL,
      '--output_format', 'txt',
      '--output_dir', outputDir,
      '--language', 'en',
    ]);

    logger.debug({ stdout, stderr }, 'Whisper output');

    const txtPath = path.join(outputDir, `${id}.txt`);
    if (!fs.existsSync(txtPath)) {
      logger.warn('Transcription file not found');
      cleanup(oggPath, wavPath, txtPath);
      return null;
    }

    const transcription = fs.readFileSync(txtPath, 'utf-8').trim();
    cleanup(oggPath, wavPath, txtPath);

    logger.info({ length: transcription.length, ms: Date.now() - t0 }, 'Audio transcribed via Whisper');
    return transcription;
  } catch (err) {
    logger.error({ err, ms: Date.now() - t0 }, 'Failed to transcribe audio');
    return null;
  }
}

function cleanup(...files: string[]): void {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      logger.debug({ file, err }, 'Failed to cleanup temp file');
    }
  }
}
