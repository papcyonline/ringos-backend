import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
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

/**
 * Upload a buffer to R2 and return BOTH the URL and the storage key (so the
 * caller can issue deletes later). Use this when you need to keep a handle
 * to the object beyond just rendering its URL.
 */
export async function uploadToR2WithKey(
  buffer: Buffer,
  folder: string,
  originalName: string,
  contentType: string,
): Promise<{ url: string; key: string }> {
  const ext = path.extname(originalName) || '.bin';
  const key = `${folder}/${uuidv4()}${ext}`;

  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  const url = publicUrl
    ? `${publicUrl}/${key}`
    : `https://${bucketName}.${accountId}.r2.dev/${key}`;
  return { url, key };
}

/**
 * Upload to R2 at a caller-specified key (no UUID). Use when you need
 * upsert-by-key semantics — avatar uploads, for example, overwrite
 * `avatars/<userId>.jpg` so the user only ever has one avatar object
 * in storage instead of leaking a new one on every change.
 */
export async function uploadToR2WithCustomKey(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<{ url: string; key: string }> {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  const url = publicUrl
    ? `${publicUrl}/${key}`
    : `https://${bucketName}.${accountId}.r2.dev/${key}`;
  return { url, key };
}

/**
 * Delete an object from R2 by key. Best-effort — caller can ignore errors.
 */
export async function deleteFromR2(key: string): Promise<void> {
  if (!isR2Configured) return;
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  }));
}

/**
 * Delete every object under a key prefix (e.g. a reel's HLS directory, which
 * holds the master playlist, per-rendition playlists, and all .ts segments).
 * Lists then batch-deletes (1000 at a time). Best-effort.
 */
export async function deleteR2Prefix(prefix: string): Promise<void> {
  if (!isR2Configured || !prefix) return;
  const client = getClient();
  // Normalise so a stored prefix key like "reels/u/uuid" only matches that
  // directory's objects, not a sibling like "reels/u/uuid2/...".
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  let token: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: normalized,
      ContinuationToken: token,
    }));
    const objects = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k);
    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
      }));
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
}
