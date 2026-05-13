import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from './logger';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const isSupabaseConfigured = !!(
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
);

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

export const BUCKETS = {
  AVATARS: 'avatar',
  CHAT_MEDIA: 'chat-media',
} as const;

export interface SupabaseUploadResult {
  url: string;
  path: string;
}

/**
 * Upload a buffer to a Supabase Storage bucket.
 * Returns the public URL and the storage path.
 */
export async function uploadToSupabase(
  buffer: Buffer,
  bucket: string,
  storagePath: string,
  contentType: string,
): Promise<SupabaseUploadResult> {
  const client = getClient();
  const { error } = await client.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    logger.error({ error, bucket, storagePath }, 'Supabase upload failed');
    throw error;
  }

  const { data } = client.storage.from(bucket).getPublicUrl(storagePath);
  // Append a timestamp so the CDN treats each upload as a new resource.
  // Without this, the CDN serves the stale cached file even after an upsert.
  const url = `${data.publicUrl}?t=${Date.now()}`;
  logger.info({ bucket, storagePath }, 'Uploaded to Supabase');
  return { url, path: storagePath };
}

/**
 * Upload a user avatar. Uses a stable per-user path so re-uploads
 * overwrite the previous file instead of accumulating objects.
 */
export async function uploadAvatarToSupabase(
  buffer: Buffer,
  userId: string,
): Promise<SupabaseUploadResult> {
  return uploadToSupabase(
    buffer,
    BUCKETS.AVATARS,
    `${userId}.jpg`,
    'image/jpeg',
  );
}

/**
 * Upload a chat image.
 */
export async function uploadChatImageToSupabase(
  buffer: Buffer,
  conversationId: string,
  originalName: string,
): Promise<SupabaseUploadResult> {
  const ext = path.extname(originalName) || '.jpg';
  const storagePath = `images/${conversationId}/${uuidv4()}${ext}`;
  const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
  return uploadToSupabase(buffer, BUCKETS.CHAT_MEDIA, storagePath, contentType);
}

/**
 * Upload a chat voice note / audio file.
 */
export async function uploadVoiceNoteToSupabase(
  buffer: Buffer,
  conversationId: string,
  originalName: string,
): Promise<SupabaseUploadResult> {
  const ext = path.extname(originalName) || '.m4a';
  const storagePath = `audio/${conversationId}/${uuidv4()}${ext}`;
  return uploadToSupabase(buffer, BUCKETS.CHAT_MEDIA, storagePath, 'audio/mp4');
}

/**
 * Delete a file from Supabase Storage. Best-effort — logs but doesn't throw.
 */
export async function deleteFromSupabase(
  bucket: string,
  storagePath: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  const client = getClient();
  const { error } = await client.storage.from(bucket).remove([storagePath]);
  if (error) {
    logger.warn({ error, bucket, storagePath }, 'Supabase delete failed');
  }
}
