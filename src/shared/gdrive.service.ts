import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { logger } from './logger';
import type { Response } from 'express';

let drive: drive_v3.Drive | null = null;
let folderId: string | null = null;

/**
 * Initialize Google Drive with OAuth2 credentials (refresh token).
 *
 * Required env vars:
 *   GDRIVE_CLIENT_ID      – OAuth2 client ID
 *   GDRIVE_CLIENT_SECRET   – OAuth2 client secret
 *   GDRIVE_REFRESH_TOKEN   – Long-lived refresh token
 *   GDRIVE_FOLDER_ID       – Target folder ID (optional)
 */
export function initGoogleDrive(): boolean {
  try {
    const clientId = process.env.GDRIVE_CLIENT_ID;
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GDRIVE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      logger.info('Google Drive not configured — missing GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, or GDRIVE_REFRESH_TOKEN');
      return false;
    }

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });

    drive = google.drive({ version: 'v3', auth: oauth2 });
    logger.info('Google Drive service initialized (OAuth2)');
    return true;
  } catch (e) {
    logger.error({ error: (e as Error).message }, 'Failed to initialize Google Drive');
    return false;
  }
}

export function isDriveConfigured(): boolean {
  return drive !== null;
}

function getFolderId(): string {
  if (folderId) return folderId;
  folderId = process.env.GDRIVE_FOLDER_ID || '';
  return folderId;
}

/**
 * Upload a buffer to Google Drive (private — no public link).
 * Returns a proxy path like /media/gdrive/<fileId> instead of a public URL.
 */
export async function uploadToDrive(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<{ url: string; fileId: string } | null> {
  if (!drive) return null;

  try {
    const parentId = getFolderId();
    const timestamp = Date.now();
    const name = `${timestamp}_${fileName}`;

    const requestBody: any = { name };
    if (parentId) requestBody.parents = [parentId];

    const file = await drive.files.create({
      requestBody,
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: 'id',
    });

    const fileId = file.data.id!;

    // No public permissions — files stay private.
    // Served via authenticated /media/gdrive/:fileId proxy endpoint.
    const url = `/media/gdrive/${fileId}`;
    logger.debug({ fileId, fileName: name }, 'File uploaded to Google Drive (private)');

    return { url, fileId };
  } catch (e) {
    logger.error({ error: (e as Error).message, fileName }, 'Google Drive upload failed');
    return null;
  }
}

/**
 * Stream a file from Google Drive to an Express response.
 */
export async function streamFromDrive(fileId: string, res: Response): Promise<boolean> {
  if (!drive) return false;

  try {
    // Get file metadata for content type
    const meta = await drive.files.get({
      fileId,
      fields: 'mimeType,size,name',
    });

    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const size = meta.data.size;

    // Stream the file content
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' },
    );

    res.setHeader('Content-Type', mimeType);
    if (size) res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'private, max-age=86400');

    (response.data as any).pipe(res);
    return true;
  } catch (e) {
    logger.error({ error: (e as Error).message, fileId }, 'Google Drive stream failed');
    return false;
  }
}

/**
 * Delete a file from Google Drive.
 */
export async function deleteFromDrive(fileId: string): Promise<void> {
  if (!drive) return;
  try {
    await drive.files.delete({ fileId });
  } catch (e) {
    logger.debug({ error: (e as Error).message, fileId }, 'Google Drive delete failed');
  }
}
