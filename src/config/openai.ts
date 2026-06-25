import OpenAI, { type ClientOptions } from 'openai';
import { env } from './env';

/**
 * Shared OpenAI client factory.
 *
 * The openai SDK v4 bundles node-fetch@2, which throws
 * ERR_STREAM_PREMATURE_CLOSE on keep-alive pooled sockets when OpenAI's
 * response is chunked/gzip-encoded. This is a latent node-fetch bug exposed by
 * the Node >=22.23 / >=24.17 `http.Agent` security fix (CVE response-queue
 * poisoning) — once triggered it fails on essentially every call, not
 * intermittently.
 *
 * Routing the SDK through the platform's native fetch (undici on Node 18+)
 * sidesteps node-fetch entirely and resolves it. As a secondary guard for the
 * node-fetch fallback path on older Node, we also request uncompressed
 * responses so there is no gzip decode step to fail.
 *
 * Use this everywhere instead of `new OpenAI(...)` directly.
 */
const nativeFetch =
  typeof globalThis.fetch === 'function'
    ? (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)
    : undefined;

export function createOpenAIClient(options: ClientOptions = {}): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    ...options,
    ...(nativeFetch ? { fetch: nativeFetch } : {}),
    defaultHeaders: { 'Accept-Encoding': 'identity', ...options.defaultHeaders },
  });
}
