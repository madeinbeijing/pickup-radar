import { createHmac } from 'node:crypto';
import { backoffDelay, sleep } from './resilience.mjs';
import { logger } from './logger.mjs';

const log = logger.child({ mod: 'notify' });

/**
 * SSE fan-out keyed by session, with replay.
 *
 * Browsers reconnect a dropped EventSource automatically and send `Last-Event-ID`.
 * Without honouring it, an arrival that fired during a 2-second reconnect is lost
 * forever — the one moment this app exists to catch. Each event carries its monotonic
 * sequence as the SSE id so the gap can be replayed on reconnect.
 */
export class EventHub {
  constructor() {
    this.clients = new Map();   // sessionId -> Set<res>
    this.delivered = 0;
  }

  add(sessionId, res) {
    if (!this.clients.has(sessionId)) this.clients.set(sessionId, new Set());
    this.clients.get(sessionId).add(res);
    return () => {
      const set = this.clients.get(sessionId);
      if (!set) return;
      set.delete(res);
      if (!set.size) this.clients.delete(sessionId);
    };
  }

  frame(event, type = 'stock') {
    const id = event.seq != null ? `id: ${event.seq}\n` : '';
    return `${id}event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  emit(sessionId, event, type = 'stock') {
    const payload = this.frame(event, type);
    let sent = 0;
    for (const res of this.clients.get(sessionId) || []) {
      try { res.write(payload); sent += 1; } catch { /* client vanished mid-write */ }
    }
    this.delivered += sent;
    return sent;
  }

  replay(res, events) {
    for (const event of events) {
      try { res.write(this.frame(event)); } catch { return; }
    }
  }

  heartbeat() {
    const stamp = `: ping ${Date.now()}\n\n`;
    for (const set of this.clients.values()) {
      for (const res of set) {
        try { res.write(stamp); } catch { /* reaped on close */ }
      }
    }
  }

  closeAll() {
    for (const set of this.clients.values()) {
      for (const res of set) { try { res.end(); } catch {} }
    }
    this.clients.clear();
  }

  count() {
    let total = 0;
    for (const set of this.clients.values()) total += set.size;
    return total;
  }

  snapshot() {
    return { sessions: this.clients.size, connections: this.count(), delivered: this.delivered };
  }
}

/** One outbound push channel. */
class Channel {
  /**
   * `check` inspects a 2xx response body. Chat-bot webhooks (Feishu, WeCom, PushPlus) answer
   * HTTP 200 even when they reject the message — a bad signature, a missing keyword, a rate
   * limit — so trusting the status alone would count a dropped alert as sent.
   */
  constructor(name, url, build, check = null) {
    this.name = name;
    this.url = url;
    this.build = build;
    this.check = check;
    this.sent = 0;
    this.failed = 0;
    this.lastError = null;
  }

  async deliver(event, timeoutMs) {
    const { url, init } = this.build(this.url, event);
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${this.name.toUpperCase()}_HTTP_${response.status}`);
    if (this.check) {
      const body = await response.json().catch(() => null);
      const failure = this.check(body);
      if (failure) throw new Error(`${this.name.toUpperCase()}_REJECTED_${failure}`);
    }
    return true;
  }
}

const alertTitle = 'Pickup · 到货提醒';
const alertLine = event => `${event.productName} ${event.capacity} ${event.colorLabel}\nApple ${event.storeName} 已显示可取货`;

/** Feishu custom-bot signature: base64(HMAC-SHA256(key = "<timestamp>\n<secret>", message = "")). */
export function feishuSign(timestamp, secret) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

const BARK_LEVELS = new Set(['active', 'timeSensitive', 'passive', 'critical']);

/** Channel options from environment variables — shared by the server and `npm run notify:test`. */
export function notifierOptionsFromEnv(env = process.env) {
  const volume = Number(env.BARK_VOLUME);
  return {
    barkUrl: env.BARK_URL || '',
    barkSound: env.BARK_SOUND ?? 'shake',
    barkCall: env.BARK_CALL !== '0',
    barkLevel: env.BARK_LEVEL || 'timeSensitive',
    barkVolume: Number.isFinite(volume) && env.BARK_VOLUME !== '' ? Math.min(10, Math.max(0, volume)) : 10,
    ntfyUrl: env.NTFY_URL || '',
    feishuUrl: env.FEISHU_WEBHOOK_URL || '',
    feishuSecret: env.FEISHU_SECRET || '',
    wecomUrl: env.WECOM_WEBHOOK_URL || '',
    pushplusToken: env.PUSHPLUS_TOKEN || ''
  };
}

/** Response-body verdicts: null when accepted, otherwise a short reason for lastError. */
const feishuCheck = body => {
  const code = body?.code ?? body?.StatusCode;
  return code === 0 ? null : `${code ?? 'NO_BODY'}${body?.msg ? `_${body.msg}` : ''}`;
};
const wecomCheck = body => (body?.errcode === 0 ? null : `${body?.errcode ?? 'NO_BODY'}${body?.errmsg ? `_${body.errmsg}` : ''}`);
const pushplusCheck = body => (body?.code === 200 ? null : `${body?.code ?? 'NO_BODY'}${body?.msg ? `_${body.msg}` : ''}`);

/**
 * Notification dispatcher with a retrying, per-channel outbox.
 *
 * A stock alert is worthless late and unrecoverable if dropped, so external pushes go
 * through a bounded queue with exponential backoff instead of fire-and-forget.
 *
 * The unit of delivery is (event x channel), not the event. Retrying a whole event would
 * re-send to channels that already succeeded — one failing ntfy would make Bark fire
 * again on every attempt. Each pending delivery therefore carries its own attempt count
 * and an idempotency key, and the queue can be persisted so a restart does not silently
 * drop alerts that were mid-retry.
 */
export class Notifier {
  constructor({ hub, store = null, barkUrl = '', barkSound = 'shake', barkCall = true, barkLevel = 'timeSensitive', barkVolume = 10, ntfyUrl = '', feishuUrl = '', feishuSecret = '', wecomUrl = '', pushplusToken = '', maxAttempts = 4, timeoutMs = 6_000, maxQueue = 500, retryBaseMs = 500 } = {}) {
    this.hub = hub;
    this.store = store;          // optional StateStore, for a durable outbox
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.queue = [];             // [{ key, channel, event, attempt }]
    this.inflight = new Map();   // key -> job, held while delivering or backing off
    this.draining = false;
    this.deadLetter = [];
    this.lastError = null;

    this.channels = [];
    if (barkUrl) {
      // An arrival is gone within minutes, so the default is loud: a distinct ringtone that
      // repeats for ~30s (call) and breaks through Focus (timeSensitive). "critical" goes
      // further and rings even with the silent switch on; volume only applies to it.
      const level = BARK_LEVELS.has(barkLevel) ? barkLevel : 'timeSensitive';
      const loudness = {
        ...(barkSound ? { sound: barkSound } : {}),
        ...(barkCall ? { call: '1' } : {}),
        level,
        ...(level === 'critical' ? { volume: barkVolume } : {})
      };
      this.channels.push(new Channel('bark', barkUrl.replace(/\/+$/, ''), (url, event) => ({
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: alertTitle,
            body: alertLine(event),
            url: event.appleUrl,
            group: 'Pickup',
            ...loudness,
            isArchive: 1
          })
        }
      })));
    }
    if (ntfyUrl) {
      this.channels.push(new Channel('ntfy', ntfyUrl, (url, event) => ({
        url,
        init: {
          method: 'POST',
          headers: {
            Title: 'Pickup - Stock Alert',
            Click: event.appleUrl,
            Priority: 'high',
            Tags: 'apple,shopping_cart'
          },
          body: `${event.productName} ${event.capacity} ${event.colorLabel} · Apple ${event.storeName} 已显示可取货`
        }
      })));
    }
    if (feishuUrl) {
      this.channels.push(new Channel('feishu', feishuUrl, (url, event) => {
        // Signed per attempt: Feishu rejects a timestamp more than an hour off, and a retry
        // after a long backoff must not reuse the original one.
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = feishuSecret ? { timestamp, sign: feishuSign(timestamp, feishuSecret) } : {};
        return {
          url,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...signature,
              msg_type: 'post',
              content: {
                post: {
                  zh_cn: {
                    title: alertTitle,
                    content: [
                      [{ tag: 'text', text: alertLine(event) }],
                      [{ tag: 'a', text: '打开 Apple 购买页', href: event.appleUrl }]
                    ]
                  }
                }
              }
            })
          }
        };
      }, feishuCheck));
    }
    if (wecomUrl) {
      // Plain text rather than markdown: markdown bot messages do not render when read
      // through WeChat's WeCom plugin.
      this.channels.push(new Channel('wecom', wecomUrl, (url, event) => ({
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'text',
            text: { content: `${alertTitle}\n${alertLine(event)}\n${event.appleUrl}` }
          })
        }
      }), wecomCheck));
    }
    if (pushplusToken) {
      this.channels.push(new Channel('pushplus', 'https://www.pushplus.plus/send', (url, event) => ({
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: pushplusToken,
            title: alertTitle,
            content: `${alertLine(event)}\n${event.appleUrl}`,
            template: 'txt'
          })
        }
      }), pushplusCheck));
    }
  }

  /** Stable per-delivery identity, so a retry can never become a duplicate send. */
  static key(event, channelName) {
    return `${event.id || `${event.watchId}:${event.storeId}:${event.fetchedAt}`}|${channelName}`;
  }

  /** Deliver to the live browser stream now, and enqueue one job per external channel. */
  send(event) {
    const streamed = this.hub?.emit(event.sessionId, event) ?? 0;
    if (!this.channels.length) return { streamed, queued: 0 };

    for (const channel of this.channels) {
      if (this.queue.length >= this.maxQueue) {
        this.queue.shift();
        log.warn('notification queue full, dropped oldest');
      }
      this.queue.push({ key: Notifier.key(event, channel.name), channel: channel.name, event, attempt: 0 });
    }
    this.persist();
    this.drain();
    return { streamed, queued: this.queue.length };
  }

  channelByName(name) {
    return this.channels.find(channel => channel.name === name) || null;
  }

  /**
   * Drain the outbox one delivery at a time.
   * A failure re-queues only that (event, channel) pair; siblings are untouched.
   */
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        const channel = this.channelByName(job.channel);
        if (!channel) continue;                       // channel removed by config change

        // Hold the job while it is being delivered or backing off. A job that is only
        // "in a local variable" is invisible to persist(), so a crash mid-backoff would
        // lose it — exactly the alert we promised to keep.
        this.inflight.set(job.key, job);
        this.persist();

        try {
          await channel.deliver(job.event, this.timeoutMs);
          channel.sent += 1;
          this.inflight.delete(job.key);
          this.persist();
          continue;
        } catch (error) {
          channel.failed += 1;
          channel.lastError = error.message;
          this.lastError = error.message;
        }

        job.attempt += 1;
        if (job.attempt >= this.maxAttempts) {
          this.deadLetter.push({ key: job.key, channel: job.channel, event: job.event, error: this.lastError, at: new Date().toISOString() });
          if (this.deadLetter.length > 50) this.deadLetter.shift();
          log.error('notification exhausted retries', { channel: job.channel, store: job.event.storeName, error: this.lastError });
          this.inflight.delete(job.key);
          this.persist();
          continue;
        }
        await sleep(backoffDelay(job.attempt, { baseMs: this.retryBaseMs, maxMs: 15_000 }));
        this.inflight.delete(job.key);
        this.queue.push(job);
        this.persist();
      }
    } finally {
      this.draining = false;
    }
  }

  /** Mirror the outbox into durable state so a restart resumes instead of dropping. */
  /** Everything not yet delivered: queued plus whatever is mid-flight or backing off. */
  pending() {
    return [...this.inflight.values(), ...this.queue];
  }

  persist() {
    this.store?.saveOutbox?.({ queue: this.pending(), deadLetter: this.deadLetter });
  }

  /** Reload a persisted outbox at startup and resume delivery. */
  restore() {
    const saved = this.store?.loadOutbox?.();
    if (!saved) return this;
    if (Array.isArray(saved.queue)) {
      this.queue = saved.queue.filter(job => job?.key && job?.channel && job?.event);
    }
    if (Array.isArray(saved.deadLetter)) this.deadLetter = saved.deadLetter;
    if (this.queue.length) {
      log.info('resuming persisted outbox', { pending: this.queue.length });
      this.drain();
    }
    return this;
  }

  snapshot() {
    const byChannel = {};
    for (const job of this.pending()) byChannel[job.channel] = (byChannel[job.channel] || 0) + 1;
    return {
      channels: this.channels.map(c => ({ name: c.name, sent: c.sent, failed: c.failed, lastError: c.lastError })),
      queued: this.pending().length,
      inflight: this.inflight.size,
      queuedByChannel: byChannel,
      durable: Boolean(this.store),
      deadLettered: this.deadLetter.length,
      lastDeadLetterAt: this.deadLetter.at(-1)?.at || null,
      lastError: this.lastError
    };
  }
}
