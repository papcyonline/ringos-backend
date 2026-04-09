import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const accountId = process.env.R2_ACCOUNT_ID;
const bucketName = process.env.R2_BUCKET_NAME;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const publicUrl = process.env.R2_PUBLIC_URL;

export const isR2Configured = !!(accountId && bucketName && accessKeyId && secretAccessKey);

let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
  }
  return s3Client;
}

/**
 * Upload a buffer to R2 and return the public URL.
 */
export async function uploadToR2(
  buffer: Buffer,
  folder: string,
  originalName: string,
  contentType: string,
): Promise<string> {
  const ext = path.extname(originalName) || '.bin';
  const key = `${folder}/${uuidv4()}${ext}`;

  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  // Return public URL
  if (publicUrl) {
    return `${publicUrl}/${key}`;
  }
  return `https://${bucketName}.${accountId}.r2.dev/${key}`;
}

/**
 * Upload an image to R2.
 */
export async function uploadImageToR2(
  buffer: Buffer,
  folder: string,
  originalName: string,
  mimeType?: string,
): Promise<string> {
  const ext = (originalName.split('.').pop() || '').toLowerCase();
  const contentType = mimeType || {
    'heic': 'image/heic', 'heif': 'image/heif',
    'png': 'image/png', 'webp': 'image/webp',
    'gif': 'image/gif',
  }[ext] || 'image/jpeg';
  return uploadToR2(buffer, folder, originalName, contentType);
}

/**
 * Upload a video to R2.
 */
export async function uploadVideoToR2(
  buffer: Buffer,
  folder: string,
  originalName: string,
): Promise<{ url: string; thumbnailUrl: string | null }> {
  const url = await uploadToR2(buffer, folder, originalName, 'video/mp4');
  // R2 doesn't auto-generate thumbnails like Cloudinary
  // Thumbnail will be null - frontend shows first frame
  return { url, thumbnailUrl: null };
}
