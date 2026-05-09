import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { callLogWriter } from '../call.log.writer';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('callLogWriter', () => {
  it('runs ops in order for the same callId', async () => {
    const order: number[] = [];
    callLogWriter.enqueue('c-1', async () => { order.push(1); });
    callLogWriter.enqueue('c-1', async () => { order.push(2); });
    callLogWriter.enqueue('c-1', async () => { order.push(3); });
    // wait for chain to drain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([1, 2, 3]);
  });

  it('catches errors and continues chain', async () => {
    const order: number[] = [];
    callLogWriter.enqueue('c-2', async () => { order.push(1); throw new Error('first fail'); });
    callLogWriter.enqueue('c-2', async () => { order.push(2); });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([1, 2]);
  });

  it('different callIds run independently', async () => {
    const finished: string[] = [];
    callLogWriter.enqueue('c-3', async () => { finished.push('c-3'); });
    callLogWriter.enqueue('c-4', async () => { finished.push('c-4'); });
    await new Promise((r) => setImmediate(r));
    expect(new Set(finished)).toEqual(new Set(['c-3', 'c-4']));
  });
});
