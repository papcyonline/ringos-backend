import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from './logger';
import { v4 as uuidv4 } from 'uuid';

// Initialize S3 client if credentials are configured
const isConfigured = !!(
  env.AWS_ACCESS_KEY_ID &&
  env.AWS_SECRET_ACCESS_KEY &&
  env.AWS_REGION &&
  env.AWS_S3_BUCKET
);

const s3Client = isConfigured
  ? new S3Client({
      region: env.AWS_REGION!,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  : null;

const BUCKET = env.AWS_S3_BUCKET;

if (isConfigured) {
  logger.info({ bucket: BUCKET, region: env.AWS_REGION }, 'AWS S3 configured');
}

export interface UploadOptions {
  folder?: string;
  filename?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  acl?: 'private' | 'public-read';
}

export interface UploadResult {
  url: string;
  key: string;
  bucket: string;
}

/**
 * Upload a file to S3 from a buffer
 */
export async function uploadBuffer(
  buffer: Buffer,
  options: UploadOptions = {}
): Promise<UploadResult | null> {
  if (!s3Client || !BUCKET) {
    logger.warn('AWS S3 not configured - upload skipped');
    return null;
  }

  const filename = options.filename || uuidv4();
  const folder = options.folder || 'uploads';
  const key = `${folder}/${filename}`;

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: options.contentType,
        Metadata: options.metadata,
        ACL: options.acl || 'private',
      })
    );

    const url =
      options.acl === 'public-read'
        ? `https://${BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
        : await getSignedDownloadUrl(key);

    logger.info({ key, bucket: BUCKET }, 'File uploaded to S3');

    return {
      url,
      key,
      bucket: BUCKET,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to upload to S3');
    throw error;
  }
}

/**
 * Upload an avatar image to S3
 */
export async function uploadAvatar(
  buffer: Buffer,
  userId: string,
  contentType: string = 'image/jpeg'
): Promise<UploadResult | null> {
  const extension = contentType.split('/')[1] || 'jpg';
  return uploadBuffer(buffer, {
    folder: 'avatars',
    filename: `${userId}.${extension}`,
    contentType,
    acl: 'public-read',
  });
}

/**
 * Upload a chat image to S3
 */
export async function uploadChatImage(
  buffer: Buffer,
  conversationId: string,
  contentType: string = 'image/jpeg'
): Promise<UploadResult | null> {
  const extension = contentType.split('/')[1] || 'jpg';
  return uploadBuffer(buffer, {
    folder: `chats/${conversationId}`,
    filename: `${uuidv4()}.${extension}`,
    contentType,
    acl: 'private',
  });
}

/**
 * Upload a voice note to S3
 */
export async function uploadVoiceNote(
  buffer: Buffer,
  conversationId: string,
  contentType: string = 'audio/mpeg'
): Promise<UploadResult | null> {
  const extension = contentType.split('/')[1] || 'mp3';
  return uploadBuffer(buffer, {
    folder: `voice/${conversationId}`,
    filename: `${uuidv4()}.${extension}`,
    contentType,
    acl: 'private',
  });
}

/**
 * Delete a file from S3
 */
export async function deleteFile(key: string): Promise<boolean> {
  if (!s3Client || !BUCKET) {
    logger.warn('AWS S3 not configured - delete skipped');
    return false;
  }

  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );
    logger.info({ key }, 'File deleted from S3');
    return true;
  } catch (error) {
    logger.error({ error, key }, 'Failed to delete from S3');
    return false;
  }
}

/**
 * Get a signed URL for downloading a private file
 */
export async function getSignedDownloadUrl(
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  if (!s3Client || !BUCKET) {
    throw new Error('AWS S3 not configured');
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Get a signed URL for uploading a file (for direct client uploads)
 */
export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn: number = 3600
): Promise<string> {
  if (!s3Client || !BUCKET) {
    throw new Error('AWS S3 not configured');
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

export { isConfigured as isS3Configured };
