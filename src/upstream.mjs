import { backoffDelay, sleep } from './resilience.mjs';

/**
 * Node's global fetch is undici-backed and already pools keep-alive connections per
 * origin, so a steady poll of one Apple host reuses TCP + TLS rather than
 * re-handshaking every time. A `node:https` Agent would be silently ignored here.
 */

// 4xx codes worth retrying. Everything else in 4xx is a contract error that retrying
// cannot fix. Any 5xx is retryable — Apple throttles with non-standard codes such as
// 541, so enumerating the standard ones is not enough.
const RETRYABLE_4XX = new Set([408, 425, 429]);
const isRetryableStatus = status => status >= 500 || RETRYABLE_4XX.has(status);
const RETRYABLE_SYSCALL = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
]);

export class UpstreamError extends Error {
  constructor(code, { status = null, retryable = false, cause = null } = {}) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

export function classify(error) {
  if (error instanceof UpstreamError) return error;
  const name = error?.name;
  const code = error?.code || error?.cause?.code;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new UpstreamError('APPLE_TIMEOUT', { retryable: true, cause: error });
  }
  if (RETRYABLE_SYSCALL.has(code)) {
    return new UpstreamError(`APPLE_NET_${code}`, { retryable: true, cause: error });
  }
  return new UpstreamError(error?.message || 'UPSTREAM_ERROR', { retryable: false, cause: error });
}

/** Honour a server-provided Retry-After (seconds or HTTP-date), clamped to a sane ceiling. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 120_000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, 120_000));
  return null;
}

const DEFAULT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
};

/**
 * GET JSON with bounded retries.
 *
 * Only retries idempotent reads on genuinely transient conditions (timeout, socket
 * error, 5xx, 429). A 4xx other than 429 is a contract problem: retrying cannot fix it
 * and only adds load, so it fails immediately.
 */
export async function fetchJson(url, {
  fetchImpl = fetch,
  timeoutMs = 7_000,
  retries = 2,
  signal,
  random = Math.random,
  onAttempt
} = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    const started = Date.now();

    try {
      const response = await fetchImpl(url, {
        headers: DEFAULT_HEADERS,
        signal: controller.signal,
        redirect: 'follow'
      });
      const latencyMs = Date.now() - started;

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        const error = new UpstreamError(`APPLE_HTTP_${response.status}`, { status: response.status, retryable });
        error.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
        throw error;
      }

      const data = await response.json();
      onAttempt?.({ attempt, ok: true, latencyMs });
      return { data, latencyMs, attempts: attempt + 1 };
    } catch (rawError) {
      const error = classify(rawError);
      error.retryAfterMs = rawError?.retryAfterMs ?? error.retryAfterMs ?? null;
      lastError = error;
      onAttempt?.({ attempt, ok: false, latencyMs: Date.now() - started, error: error.code });

      const budgetLeft = attempt < retries;
      if (!error.retryable || !budgetLeft || signal?.aborted) break;

      const wait = error.retryAfterMs ?? backoffDelay(attempt, { baseMs: 300, maxMs: 4_000, random });
      await sleep(wait, signal).catch(() => {});
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  throw lastError || new UpstreamError('UPSTREAM_ERROR');
}
