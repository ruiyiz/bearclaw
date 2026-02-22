import { logger } from './logger.js';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_v3';

export async function generateSpeech(text: string): Promise<Buffer | null> {
  if (!API_KEY) {
    logger.debug('ELEVENLABS_API_KEY not set, skipping TTS');
    return null;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=opus_48000_128`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logger.error({ status: response.status, errText }, 'ElevenLabs TTS failed');
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logger.error({ err }, 'ElevenLabs TTS error');
    return null;
  }
}
