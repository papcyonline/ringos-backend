import { PrismaClient } from '@prisma/client';
import { logger } from '../shared/logger';
import { env } from './env';
import { encryptContent, decryptContent } from '../shared/message-crypto';

// Append connection pool params if not already in the URL.
//
// connection_limit: max DB connections per backend instance.
//   - Total across N instances must stay below Postgres max_connections
//     (Render free PG = 97). With Redis-backed call state we run multiple
//     instances; size accordingly: pick `floor(max_connections / instances)`.
//   - Default 30 is safe up to ~3 instances on a 97-cap DB. Override via
//     DATABASE_URL ?connection_limit=N for larger fleets or pgbouncer setups.
//   - Scale > 5 instances: deploy pgbouncer in transaction-pool mode and
//     set this to 100+ per instance (each app conn becomes a virtual conn).
//
// pool_timeout: seconds to wait for a free connection before erroring.
//   Burst tolerance — when CallLog write-behind queues spike, requests
//   queue against this. 10s is generous; lower it to fail-fast in dev.
const dbUrl = env.DATABASE_URL;
const pooledUrl = dbUrl.includes('connection_limit')
  ? dbUrl
  : `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}connection_limit=30&pool_timeout=10`;

export const prisma = new PrismaClient({
  datasourceUrl: pooledUrl,
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

// ─── Message encryption-at-rest middleware ─────────────────
// Transparently encrypts Message.content on write and decrypts it on read
// (including messages nested under Conversation includes and inside interactive
// transactions). Marker-gated, so legacy plaintext rows pass through untouched
// and it's a full no-op until MESSAGE_ENC_KEY is set. See shared/message-crypto.
const _WRITE_ACTIONS = new Set([
  'create',
  'update',
  'upsert',
  'createMany',
  'updateMany',
]);

function _encryptWriteData(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const d of data) _encryptWriteData(d);
    return;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.content === 'string') obj.content = encryptContent(obj.content);
  // upsert carries create/update sub-objects.
  if (obj.create) _encryptWriteData(obj.create);
  if (obj.update) _encryptWriteData(obj.update);
}

function _decryptRead(node: unknown, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) _decryptRead(n, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.content === 'string') obj.content = decryptContent(obj.content);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') _decryptRead(v, depth + 1);
  }
}

prisma.$use(async (params, next) => {
  if (
    params.model === 'Message' &&
    params.action &&
    _WRITE_ACTIONS.has(params.action) &&
    params.args?.data
  ) {
    _encryptWriteData(params.args.data);
  }
  const result = await next(params);
  // Decrypt content on reads of Message (direct) and Conversation (nested
  // messages). Marker-gated, so non-message content strings pass through.
  if (params.model === 'Message' || params.model === 'Conversation') {
    _decryptRead(result);
  }
  return result;
});

prisma.$on('error', (e) => {
  logger.error(e, 'Prisma error');
});

prisma.$on('warn', (e) => {
  logger.warn(e, 'Prisma warning');
});

export async function connectDatabase() {
  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (error) {
    logger.error(error, 'Failed to connect to database');
    process.exit(1);
  }
}

/**
 * Idempotently ensure additive, nullable columns exist before the app serves
 * traffic — a safety net so a code deploy is never ahead of its schema (Prisma
 * would otherwise error writing to a not-yet-migrated column). Only ADD COLUMN
 * IF NOT EXISTS on nullable columns belongs here (safe + reversible); anything
 * structural must go through a real migration. Non-fatal: logs and continues.
 */
export async function ensureAdditiveColumns() {
  const statements = [
    // Adaptive HLS for reels (self-hosted on R2). See 20260719000001_add_reel_hls.
    'ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "hlsUrl" TEXT',
    'ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "hlsKey" TEXT',
  ];
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      logger.warn({ err, sql }, 'ensureAdditiveColumns: statement failed (continuing)');
    }
  }
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
