import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { logger } from './logger';

// ── Config ──

const FOLDER_NAME = 'Yomeet Chat Media';
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
      scopes: ['https://www.googleapis.com/auth/drive.file'],
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
 * Get or create the shared media folder.
 */
async function getOrCreateFolder(): Promise<string> {
  if (folderId) return folderId;
  if (!drive) throw new Error('Drive not initialized');

  // Search for existing folder
  const res = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  if (res.data.files && res.data.files.length > 0) {
    folderId = res.data.files[0].id!;
    return folderId;
  }

  // Create folder
  const folder = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  folderId = folder.data.id!;

  // Make folder publicly readable
  await drive.permissions.create({
    fileId: folderId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

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
    const parentId = await getOrCreateFolder();
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
