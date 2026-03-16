import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { logger } from './logger';

// ── Config ──

// Use a pre-shared folder from the app owner's Drive.
// Set GDRIVE_FOLDER_ID env var, or falls back to creating one.
let drive: drive_v3.Drive | null = null;
let folderId: string | null = null;

/**
 * Initialize Google Drive with a service account.
 * Reads credentials from GOOGLE_SERVICE_ACCOUNT_JSON env var (JSON string)
 * or GOOGLE_SERVICE_ACCOUNT_FILE env var (file path).
 */
export function initGoogleDrive(): boolean {
  try {
    let credentials: any;

    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
      credentials = require(process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
    } else {
      logger.info('Google Drive not configured — no service account credentials found');
      return false;
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    drive = google.drive({ version: 'v3', auth });
    logger.info('Google Drive service initialized');
    return true;
  } catch (e) {
    logger.error({ error: (e as Error).message }, 'Failed to initialize Google Drive');
    return false;
  }
}

export function isDriveConfigured(): boolean {
  return drive !== null;
}

/**
 * Get the shared folder ID from env or use the pre-configured one.
 */
function getFolderId(): string {
  if (folderId) return folderId;
  folderId = process.env.GDRIVE_FOLDER_ID || '1MFws6S5agAIlStM2FmLaD81i_Rq3yy6t';
  return folderId;
}

/**
 * Upload a buffer to Google Drive and return a public URL.
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

    const file = await drive.files.create({
      requestBody: {
        name,
        parents: [parentId],
      },
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: 'id',
      supportsAllDrives: true,
    });

    const fileId = file.data.id!;

    // Make publicly readable
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    const url = `https://drive.google.com/uc?export=view&id=${fileId}`;
    logger.debug({ fileId, fileName: name }, 'File uploaded to Google Drive');

    return { url, fileId };
  } catch (e) {
    logger.error({ error: (e as Error).message, fileName }, 'Google Drive upload failed');
    return null;
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
