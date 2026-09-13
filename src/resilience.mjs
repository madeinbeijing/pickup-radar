/**
 * Resilience primitives modelled on resilience4j / Envoy outlier detection.
 * Every component is deterministic under an injected clock so it can be unit tested.
 */

/**
 * Awaitable delay. Deliberately NOT unref'd: a caller is awaiting this timer, so
 * letting the event loop exit while it is pending would hang that await forever.
 */
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new Error('ABORTED'));
  }, { once: true });
});

/**
 * Three-state circuit breaker.
 *
 * closed ──(failureThreshold consecutive failures)──> open
 * open   ──(after openMs)──────────────────────────> half-open
 * half-open ──(probeSuccesses OK)──> closed   ──(1 failure)──> open (with backoff)
 *
 * Unlike a two-state breaker, half-open admits a *bounded* number of probes, so a
 * recovering upstream is never stampeded by every queued caller at once.
 */
export class CircuitBreaker {
  constructor({
    name = 'default',
    failureThreshold = 4,
    openMs = 20_000,
    maxOpenMs = 5 * 60_000,
    probeSuccesses = 2,
    maxProbes = 1,
    now = () => Date.now()
  } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.baseOpenMs = openMs;
    this.maxOpenMs = maxOpenMs;
    this.probeSuccesses = probeSuccesses;
    this.maxProbes = maxProbes;
    this.now = now;
    this.reset();
  }

  reset() {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.openMs = this.baseOpenMs;
    this.consecutiveOpens = 0;
    this.inFlightProbes = 0;
    this.lastError = null;
    this.lastTransitionAt = null;
  }

  /** Roll open -> half-open once the cooldown elapses. */
  refresh() {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openMs) {
      this.state = 'half-open';
      this.successes = 0;
      this.inFlightProbes = 0;
      this.lastTransitionAt = new Date(this.now()).toISOString();
    }
    return this.state;
  }

  /** True when a call may proceed. Half-open admits at most `maxProbes` at a time. */
  tryAcquire() {
    const state = this.refresh();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.inFlightProbes >= this.maxProbes) return false;
    this.inFlightProbes += 1;
    return true;
  }

  onSuccess() {
    if (this.state === 'half-open') {
      this.inFlightProbes = Math.max(0, this.inFlightProbes - 1);
      this.successes += 1;
      if (this.successes < this.probeSuccesses) return;
      this.state = 'closed';
      this.failures = 0;
      this.successes = 0;
      this.openMs = this.baseOpenMs;
      this.consecutiveOpens = 0;
      this.lastTransitionAt = new Date(this.now()).toISOString();
      return;
    }
    this.failures = 0;
  }

  onFailure(error) {
    this.lastError = error?.message || String(error || 'ERROR');
    if (this.state === 'half-open') {
      this.inFlightProbes = Math.max(0, this.inFlightProbes - 1);
      return this.trip();
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  /** Open with exponential backoff so a persistently dead upstream is probed ever more rarely. */
  trip() {
    this.state = 'open';
    this.openedAt = this.now();
    this.successes = 0;
    this.openMs = Math.min(this.maxOpenMs, this.baseOpenMs * 2 ** this.consecutiveOpens);
    this.consecutiveOpens += 1;
    this.lastTransitionAt = new Date(this.openedAt).toISOString();
  }

  retryAfterMs() {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.openMs - (this.now() - this.openedAt));
  }

  snapshot() {
    this.refresh();
    return {
      state: this.state,
      failures: this.failures,
      consecutiveOpens: this.consecutiveOpens,
      openMs: this.state === 'open' ? this.openMs : 0,
      retryAfterMs: this.retryAfterMs(),
      lastError: this.lastError,
      lastTransitionAt: this.lastTransitionAt
    };
  }
}

/**
 * Token bucket. Enforces a sustained rate with a burst allowance, so the app is a
 * well-behaved client of Apple regardless of how many watches exist.
 */
export class TokenBucket {
  constructor({ capacity = 6, refillPerSec = 1, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  refill() {
    const now = this.now();
    const elapsed = (now - this.updatedAt) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.updatedAt = now;
  }

  /** Milliseconds until a token is available (0 when one can be taken right now). */
  delayMs() {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }

  take() {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async acquire(signal) {
    for (;;) {
      const wait = this.delayMs();
      if (wait === 0 && this.take()) return;
      await sleep(Math.max(wait, 5), signal);
    }
  }

  snapshot() {
    this.refill();
    return { tokens: Math.floor(this.tokens * 100) / 100, capacity: this.capacity, refillPerSec: this.refillPerSec };
  }
}

/** Counting semaphore bounding in-flight work. */
export class Semaphore {
  constructor(limit = 4) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  async run(task) {
    await this.acquire();
    try { return await task(); }
    finally { this.release(); }
  }

  snapshot() {
    return { active: this.active, limit: this.limit, queued: this.queue.length };
  }
}

/**
 * Full-jitter exponential backoff (AWS Architecture Blog). Full jitter beats
 * equal/decorrelated jitter at spreading a thundering herd of retries.
 */
export function backoffDelay(attempt, { baseMs = 300, maxMs = 8_000, random = Math.random } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/** Bounded-concurrency map that preserves input order and never rejects. */
export async function mapPool(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = { ok: true, value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
