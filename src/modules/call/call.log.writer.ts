/**
 * Write-behind buffer for CallLog operations.
 *
 * Why: under burst load (50k+ concurrent call starts), a synchronous
 * `await prisma.callLog.create(...)` inside a socket handler queues on
 * Prisma's connection pool and back-pressures the signalling layer — users
 * see "calling…" delayed by hundreds of ms while waiting for analytics
 * writes to land. CallLog is a history record; its persistence is not on
 * the critical path of the call itself.
 *
 * Design (KISS / SRP / YAGNI):
 *   - One promise chain per callId so writes for the same call stay FIFO
 *     (create → answer-update → end-update can't reorder).
 *   - Independent calls write in parallel, only bounded by Prisma's pool.
 *   - Producers (gateway handlers) call `enqueue(callId, op)` and return
 *     immediately. Errors are caught + logged; we never propagate.
 *   - The chain Map self-prunes when the tail of a chain settles, so it
 *     doesn't grow without bound.
 *
 * What this is NOT (intentional YAGNI):
 *   - Not a durable queue. Process restart loses any pending writes.
 *     For our use case (analytics rows), missing a few rows during a
 *     crash is acceptable — the call still happened, the call already
 *     emitted live events to clients, and the row would only have shown
 *     up in history.
 *   - Not a retry framework. A failed write is logged, not retried.
 *   - Not BullMQ. Adding a worker process for analytics writes would
 *     give us durability we don't currently need at higher operational
 *     cost.
 */

import { logger } from '../../shared/logger';

type WriteOp = () => Promise<unknown>;

class CallLogWriter {
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Append a write to this callId's chain. Returns immediately; the write
   * happens in the background, ordered after any pending writes for the
   * same callId.
   */
  enqueue(callId: string, op: WriteOp): void {
    const previous = this.chains.get(callId) ?? Promise.resolve();
    const next = previous
      .then(() => op())
      .catch((err) => {
        logger.error({ err, callId }, 'CallLog write-behind op failed');
      })
      .then(() => {
        // Self-prune: if no newer write was chained behind us, remove the
        // entry so the Map doesn't grow forever.
        if (this.chains.get(callId) === next) this.chains.delete(callId);
      });
    this.chains.set(callId, next);
  }

  /**
   * Resolve when all currently-pending writes for a given callId have
   * drained. Used by tests; production code should never need this.
   */
  async drain(callId: string): Promise<void> {
    const pending = this.chains.get(callId);
    if (pending) await pending;
  }

  /** Number of callIds with pending writes. Useful for metrics. */
  get backlogSize(): number {
    return this.chains.size;
  }
}

export const callLogWriter = new CallLogWriter();
