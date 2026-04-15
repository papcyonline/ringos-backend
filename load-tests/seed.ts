/**
 * Seed N pairs of test users + minted JWTs + a HUMAN_MATCHED conversation
 * between each pair. Outputs JSON for downstream load tests:
 *
 *   [{ id, token, calleeId, conversationId }, ...]
 *
 * Each row is a CALLER. The Artillery scenario runs as that caller and
 * places a call to `calleeId` over `conversationId`.
 *
 * Usage:
 *   LOAD_TEST_DB_URL=postgres://... \
 *   JWT_SECRET=...                  \
 *     npx ts-node load-tests/seed.ts --pairs 100 --out users.json
 *
 * Safety: refuses to run unless LOAD_TEST_DB_URL is explicitly set, so
 * the production DATABASE_URL can never be touched by accident.
 *
 * Cleanup: pass --cleanup to delete every user/conversation tagged
 * during a previous seed (matches displayName starts with "Load Test ").
 */

import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { writeFileSync } from 'fs';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[i + 1] ?? 'true');
}

const PAIRS = Number(args.get('pairs') ?? 50);
const OUT = args.get('out');
const CLEANUP = args.get('cleanup') === 'true';
const TEST_DB_URL = process.env.LOAD_TEST_DB_URL;
const SECRET = process.env.JWT_SECRET;

if (!TEST_DB_URL) {
  console.error('Refusing to seed: set LOAD_TEST_DB_URL (must NOT be your prod DB)');
  process.exit(1);
}
if (!SECRET) {
  console.error('JWT_SECRET env required (must match the backend you target)');
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL });

async function cleanup() {
  const result = await prisma.user.deleteMany({
    where: { displayName: { startsWith: 'Load Test ' } },
  });
  console.error(`deleted ${result.count} test users (conversations + participants cascade)`);
}

async function seed() {
  const rows: Array<{
    id: string;
    token: string;
    calleeId: string;
    conversationId: string;
  }> = [];

  for (let i = 0; i < PAIRS; i++) {
    const stamp = Date.now();
    const [caller, callee] = await Promise.all([
      prisma.user.create({
        data: {
          email: `loadtest_${stamp}_${i}_a@loadtest.local`,
          displayName: `Load Test ${i}A`,
        } as any,
      }),
      prisma.user.create({
        data: {
          email: `loadtest_${stamp}_${i}_b@loadtest.local`,
          displayName: `Load Test ${i}B`,
        } as any,
      }),
    ]);

    const conv = await prisma.conversation.create({
      data: {
        type: 'HUMAN_MATCHED',
        status: 'ACTIVE',
        participants: {
          create: [
            { userId: caller.id },
            { userId: callee.id },
          ],
        },
      },
    });

    const token = jwt.sign({ userId: caller.id, isAnonymous: false }, SECRET, {
      expiresIn: '24h',
    });

    rows.push({
      id: caller.id,
      token,
      calleeId: callee.id,
      conversationId: conv.id,
    });

    if ((i + 1) % 25 === 0) console.error(`seeded ${i + 1}/${PAIRS} pairs`);
  }

  const payload = JSON.stringify(rows, null, 2);
  if (OUT) {
    writeFileSync(OUT, payload);
    console.error(`wrote ${rows.length} pairs to ${OUT}`);
  } else {
    process.stdout.write(payload);
  }
}

(async () => {
  try {
    if (CLEANUP) {
      await cleanup();
    } else {
      await seed();
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
