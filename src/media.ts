import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from './config.js';
import { logger } from './logger.js';
import { MediaSource } from './types.js';

const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function guessMimetype(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function resolveMediaSource(
  filePath: string | null | undefined,
  mediaUrl: string | null | undefined,
  sourceAgent: string,
): MediaSource | null {
  if (mediaUrl) {
    return { url: mediaUrl };
  }

  if (filePath) {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(AGENTS_DIR, sourceAgent, filePath);

    if (!fs.existsSync(resolvedPath)) {
      logger.error({ resolvedPath, sourceAgent }, 'Media file not found');
      return null;
    }
    return { buffer: fs.readFileSync(resolvedPath) };
  }

  return null;
}
