import { PrismaClient } from '@prisma/client';
import { logger } from '../shared/logger';
import { env } from './env';

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

export async function disconnectDatabase() {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
