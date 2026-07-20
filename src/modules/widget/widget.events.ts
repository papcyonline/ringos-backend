import { EventEmitter } from 'events';
import { getRedis } from '../../shared/redis.service';
import { logger } from '../../shared/logger';

/**
 * Real-time fan-out for the website widget's SSE streams.
 *
 * A visitor's browser holds an SSE connection on ONE server instance, but the
 * owner's reply (or typing) may be produced on ANOTHER. So events go through a
 * local EventEmitter for same-instance delivery, bridged over Redis pub/sub for
 * cross-instance delivery (matching how Socket.IO already scales here). With no
 * Redis configured it degrades to single-instance in-memory — still correct.
 *
 * Events are tiny "nudges" (`{ type: 'message' | 'typing' }`) keyed by
 * conversationId; the SSE handler just tells the widget to refresh, so the
 * message serialization stays in one place (visitorGetMessages) — DRY.
 */
const local = new EventEmitter();
local.setMaxListeners(0);

const CHANNEL = 'widget:events';

export interface WidgetEvent {
  conversationId: string;
  type: 'message' | 'typing';
}

let bridged = false;
/** Lazily attach the Redis→local bridge (once) when the first SSE subscribes. */
function ensureBridge(): void {
  if (bridged) return;
  const redis = getRedis();
  if (!redis) return; // single-instance: local emitter is enough
  bridged = true;
  const sub = redis.duplicate();
  sub.on('error', (err) => logger.warn({ err }, 'widget events subscriber error'));
  sub.subscribe(CHANNEL).catch((err) =>
    logger.warn({ err }, 'widget events subscribe failed'),
  );
  sub.on('message', (_channel: string, message: string) => {
    try {
      const evt = JSON.parse(message) as WidgetEvent;
      local.emit(evt.conversationId, evt);
    } catch {
      /* ignore malformed */
    }
  });
}

/** Publish a widget event. Redis (cross-instance) when available, else local. */
export function emitWidgetEvent(conversationId: string, type: WidgetEvent['type']): void {
  const evt: WidgetEvent = { conversationId, type };
  const redis = getRedis();
  if (redis) {
    // The bridge re-emits to local on every instance (incl. this one), so we
    // publish ONLY to Redis to avoid a same-instance double-emit.
    redis.publish(CHANNEL, JSON.stringify(evt)).catch(() => {});
  } else {
    local.emit(conversationId, evt);
  }
}

/** Subscribe an SSE handler to one conversation's events. Returns unsubscribe. */
export function onWidgetEvent(
  conversationId: string,
  handler: (evt: WidgetEvent) => void,
): () => void {
  ensureBridge();
  local.on(conversationId, handler);
  return () => local.off(conversationId, handler);
}
