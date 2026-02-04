import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { env } from '../config/env';
import { logger } from './logger';

// Initialize Cloudinary if credentials are configured
const isConfigured = !!(
  env.CLOUDINARY_CLOUD_NAME &&
  env.CLOUDINARY_API_KEY &&
  env.CLOUDINARY_API_SECRET
);

if (isConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  logger.info('Cloudinary configured');
}

export interface UploadOptions {
  folder?: string;
  publicId?: string;
  transformation?: {
    width?: number;
    height?: number;
    crop?: string;
    quality?: string | number;
  };
  resourceType?: 'image' | 'video' | 'raw' | 'auto';
}

export interface UploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  width?: number;
  height?: number;
  format?: string;
  bytes?: number;
}

/**
 * Upload a file to Cloudinary from a buffer
 */
export async function uploadBuffer(
  buffer: Buffer,
  options: UploadOptions = {}
): Promise<UploadResult | null> {
  if (!isConfigured) {
    logger.warn('Cloudinary not configured - upload skipped');
    return null;
  }

  try {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: options.folder || 'yomeet',
          public_id: options.publicId,
          resource_type: options.resourceType || 'auto',
          transformation: options.transformation
            ? [
                {
                  width: options.transformation.width,
                  height: options.transformation.height,
                  crop: options.transformation.crop || 'fill',
                  quality: options.transformation.quality || 'auto',
                },
              ]
            : undefined,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result!);
        }
      );
      uploadStream.end(buffer);
    });

    logger.info({ publicId: result.public_id, bytes: result.bytes }, 'File uploaded to Cloudinary');

    return {
      url: result.url,
      secureUrl: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to upload to Cloudinary');
    throw error;
  }
}

/**
 * Upload a file to Cloudinary from a URL
 */
export async function uploadUrl(
  url: string,
  options: UploadOptions = {}
): Promise<UploadResult | null> {
  if (!isConfigured) {
    logger.warn('Cloudinary not configured - upload skipped');
    return null;
  }

  try {
    const result = await cloudinary.uploader.upload(url, {
      folder: options.folder || 'yomeet',
      public_id: options.publicId,
      resource_type: options.resourceType || 'auto',
      transformation: options.transformation
        ? [
            {
              width: options.transformation.width,
              height: options.transformation.height,
              crop: options.transformation.crop || 'fill',
              quality: options.transformation.quality || 'auto',
            },
          ]
        : undefined,
    });

    logger.info({ publicId: result.public_id, bytes: result.bytes }, 'URL uploaded to Cloudinary');

    return {
      url: result.url,
      secureUrl: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to upload URL to Cloudinary');
    throw error;
  }
}

/**
 * Upload an avatar image with automatic optimization
 */
export async function uploadAvatar(
  buffer: Buffer,
  userId: string
): Promise<UploadResult | null> {
  return uploadBuffer(buffer, {
    folder: 'yomeet/avatars',
    publicId: `avatar_${userId}`,
    transformation: {
      width: 400,
      height: 400,
      crop: 'fill',
      quality: 'auto',
    },
  });
}

/**
 * Upload a chat image
 */
export async function uploadChatImage(
  buffer: Buffer,
  conversationId: string
): Promise<UploadResult | null> {
  return uploadBuffer(buffer, {
    folder: `yomeet/chats/${conversationId}`,
    transformation: {
      width: 1200,
      height: 1200,
      crop: 'limit',
      quality: 'auto',
    },
  });
}

/**
 * Upload a voice note
 */
export async function uploadVoiceNote(
  buffer: Buffer,
  conversationId: string
): Promise<UploadResult | null> {
  return uploadBuffer(buffer, {
    folder: `yomeet/voice/${conversationId}`,
    resourceType: 'video', // Cloudinary uses 'video' for audio files
  });
}

/**
 * Delete a file from Cloudinary
 */
export async function deleteFile(publicId: string, resourceType: 'image' | 'video' | 'raw' = 'image'): Promise<boolean> {
  if (!isConfigured) {
    logger.warn('Cloudinary not configured - delete skipped');
    return false;
  }

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    logger.info({ publicId }, 'File deleted from Cloudinary');
    return true;
  } catch (error) {
    logger.error({ error, publicId }, 'Failed to delete from Cloudinary');
    return false;
  }
}

/**
 * Generate a transformation URL for an existing image
 */
export function getTransformedUrl(
  publicId: string,
  transformation: { width?: number; height?: number; crop?: string; quality?: string | number }
): string {
  if (!isConfigured) {
    return '';
  }

  return cloudinary.url(publicId, {
    transformation: [
      {
        width: transformation.width,
        height: transformation.height,
        crop: transformation.crop || 'fill',
        quality: transformation.quality || 'auto',
      },
    ],
    secure: true,
  });
}

export { isConfigured as isCloudinaryConfigured };
