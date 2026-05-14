import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface DownloadedImageAttachment {
  remoteKey: string;
  localPath: string;
  mimeType: string;
  dataUrl: string;
}

export function resolveImageAttachmentPath(
  imageDir: string,
  remoteKey: string
): string {
  mkdirSync(imageDir, { recursive: true });
  return path.join(imageDir, `${sanitizeFileName(remoteKey)}.bin`);
}

export function buildDownloadedImageAttachment(
  remoteKey: string,
  localPath: string
): DownloadedImageAttachment | null {
  const buffer = readFileSync(localPath);
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType) {
    return null;
  }

  return {
    remoteKey,
    localPath,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*]+/gu, '_');
}

function detectImageMimeType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (
    buffer.length >= 6 &&
    (buffer.toString('ascii', 0, 6) === 'GIF87a' ||
      buffer.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }

  return null;
}

