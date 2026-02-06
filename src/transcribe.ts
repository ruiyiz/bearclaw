/**
 * Voice message transcription using local Whisper
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_PATH = process.env.WHISPER_PATH || '/Users/ruiyiz/.local/bin/whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small'; // or 'large-v3-turbo'
const TEMP_DIR = path.join(STORE_DIR, 'audio_temp');

// Ensure temp directory exists
fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function transcribeAudioMessage(
  msg: proto.IWebMessageInfo,
): Promise<string | null> {
  try {
    if (!msg.key) {
      logger.warn('Message has no key');
      return null;
    }

    // Download the audio file
    const buffer = await downloadMediaMessage(msg as any, 'buffer', {});
    if (!buffer) {
      logger.warn('No buffer returned from audio download');
      return null;
    }

    const audioId = msg.key.id || `audio_${Date.now()}`;
    const oggPath = path.join(TEMP_DIR, `${audioId}.ogg`);
    const wavPath = path.join(TEMP_DIR, `${audioId}.wav`);

    // Write OGG file
    fs.writeFileSync(oggPath, buffer);

    // Convert to WAV format (Whisper works better with WAV)
    try {
      await execFileAsync('ffmpeg', [
        '-i', oggPath,
        '-ar', '16000', // 16kHz sample rate
        '-ac', '1',     // mono
        '-y',           // overwrite
        wavPath
      ]);
    } catch (err) {
      logger.error({ err }, 'Failed to convert audio to WAV');
      cleanup(oggPath, wavPath);
      return null;
    }

    // Transcribe with Whisper
    const outputDir = TEMP_DIR;
    const { stdout, stderr } = await execFileAsync(WHISPER_PATH, [
      wavPath,
      '--model', WHISPER_MODEL,
      '--output_format', 'txt',
      '--output_dir', outputDir,
      '--language', 'en', // or 'auto' for auto-detection
    ]);

    logger.debug({ stdout, stderr }, 'Whisper output');

    // Read transcription
    const txtPath = path.join(outputDir, `${audioId}.txt`);
    if (!fs.existsSync(txtPath)) {
      logger.warn('Transcription file not found');
      cleanup(oggPath, wavPath, txtPath);
      return null;
    }

    const transcription = fs.readFileSync(txtPath, 'utf-8').trim();

    // Cleanup temp files
    cleanup(oggPath, wavPath, txtPath);

    logger.info({ length: transcription.length }, 'Audio transcribed successfully');
    return transcription;

  } catch (err) {
    logger.error({ err }, 'Failed to transcribe audio message');
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
