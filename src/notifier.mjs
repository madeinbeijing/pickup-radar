import { createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
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

  /** Send one frame to every connected session — for state shared by all viewers. */
  broadcast(event, type) {
    let sent = 0;
    for (const sessionId of this.clients.keys()) sent += this.emit(sessionId, event, type);
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

/**
 * POST a plain-HTTP request to a tailnet service through the runtime tunnel proxy.
 * The proxy lives on the same host as HTTPS_PROXY with port 3130 (the Tailscale
 * selector); its auth comes from HTTPS_PROXY itself, never from a file. This sends
 * a classic forward-proxy request — absolute target URL as the request path plus
 * Proxy-Authorization — exactly what curl does, and the path the tunnel provably
 * answers. The socket itself goes to the proxy via a custom agent; the request
 * authority stays the target, which is also what Node's HTTP client validation
 * requires (a CONNECT tunnel hung up on this proxy, so it is not used).
 */
function postViaTunnelProxy(targetUrl, init, timeoutMs) {
  const proxyEnv = process.env.HTTPS_PROXY || '';
  if (!proxyEnv) throw new Error('MAC_NO_TUNNEL_PROXY');
  const proxy = new URL(proxyEnv);
  const target = new URL(targetUrl);
  const body = init.body ?? '';
  // NOTE: createConnection is NOT an Agent constructor option (it would be silently
  // ignored, leaving a direct — sandbox-blocked — connection to the target). It must
  // be assigned on the instance so the agent dials the proxy instead of the target.
  const agent = new http.Agent();
  agent.createConnection = () => net.connect({ host: proxy.hostname, port: 3130 });
  return new Promise((resolve, reject) => {
    const done = (fn, value) => { agent.destroy(); fn(value); };
    const req = http.request({
      agent,
      host: target.hostname,
      port: target.port || 80,
      method: init.method || 'POST',
      path: targetUrl,
      timeout: timeoutMs,
      headers: {
        ...(init.headers || {}),
        Host: target.host,
        'Content-Length': Buffer.byteLength(body),
        'Proxy-Authorization': `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
        ).toString('base64')}`
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          done(reject, new Error(`MAC_HTTP_${res.statusCode}`));
          return;
        }
        try { done(resolve, JSON.parse(Buffer.concat(chunks).toString() || 'null')); }
        catch { done(resolve, null); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('MAC_TIMEOUT')); agent.destroy(); });
    req.on('error', (error) => done(reject, error));
    req.end(body);
  });
}

/** One outbound push channel. */
class Channel {
  /**
   * `check` inspects a 2xx response body. Chat-bot webhooks (Feishu, WeCom, PushPlus) answer
   * HTTP 200 even when they reject the message — a bad signature, a missing keyword, a rate
   * limit — so trusting the status alone would count a dropped alert as sent.
   * `viaProxy` routes a plain-HTTP target through the tunnel proxy instead of fetch
   * (used by the Mac channel: the tailnet is reachable only through that proxy).
   */
  constructor(name, url, build, check = null, viaProxy = false) {
    this.name = name;
    this.url = url;
    this.build = build;
    this.check = check;
    this.viaProxy = viaProxy;
    this.sent = 0;
    this.failed = 0;
    this.lastError = null;
  }

  async deliver(event, timeoutMs) {
    const { url, init } = this.build(this.url, event);
    if (this.viaProxy) {
      const body = await postViaTunnelProxy(url, init, timeoutMs);
      if (this.check) {
        const failure = this.check(body);
        if (failure) throw new Error(`${this.name.toUpperCase()}_REJECTED_${failure}`);
      }
      return true;
    }
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
const alertLine = event => event.alertText || `${event.productName} ${event.capacity} ${event.colorLabel}\nApple ${event.storeName} 已显示可取货`;

/**
 * Fold arrivals held back by the push cooldown into one push. Grouped by configuration so
 * each line names the stores for one config; the web stream still received each event.
 */
export function mergeArrivals(events) {
  const groups = new Map();
  for (const event of events) {
    const config = `${event.productName} ${event.capacity} ${event.colorLabel}`;
    if (!groups.has(config)) groups.set(config, new Set());
    groups.get(config).add(event.storeName);
  }
  const lines = [...groups].map(([config, stores]) => `${config}\nApple ${[...stores].join('、')} 已显示可取货`);
  const last = events.at(-1);
  return {
    ...last,
    id: `merged-${events[0].id || last.fetchedAt || ''}-${events.length}`,
    storeName: [...new Set(events.map(event => event.storeName))].join('、'),
    mergedCount: events.length,
    alertText: lines.join('\n')
  };
}

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
    // External-push gate (Leon's rule, 2026-10-23): when PUSH_ONLY_SKU is set, only that
    // SKU may push to the phone, and PUSH_COOLDOWN_MS caps pushes to one per window
    // across all stores and sessions, so a burst collapses into a single alert.
    pushOnlySku: env.PUSH_ONLY_SKU || '',
    pushCooldownMs: Number.isFinite(Number(env.PUSH_COOLDOWN_MS)) && env.PUSH_COOLDOWN_MS !== '' ? Math.max(0, Number(env.PUSH_COOLDOWN_MS)) : 0,
    ntfyUrl: env.NTFY_URL || '',
    feishuUrl: env.FEISHU_WEBHOOK_URL || '',
    feishuSecret: env.FEISHU_SECRET || '',
    wecomUrl: env.WECOM_WEBHOOK_URL || '',
    pushplusToken: env.PUSHPLUS_TOKEN || '',
    macListenerUrl: env.MAC_LISTENER_URL || '',
    macListenerToken: env.MAC_LISTENER_TOKEN || ''
  };
}

/** Response-body verdicts: null when accepted, otherwise a short reason for lastError. */
const feishuCheck = body => {
  const code = body?.code ?? body?.StatusCode;
  return code === 0 ? null : `${code ?? 'NO_BODY'}${body?.msg ? `_${body.msg}` : ''}`;
};
const wecomCheck = body => (body?.errcode === 0 ? null : `${body?.errcode ?? 'NO_BODY'}${body?.errmsg ? `_${body.errmsg}` : ''}`);
const pushplusCheck = body => (body?.code === 200 ? null : `${body?.code ?? 'NO_BODY'}${body?.msg ? `_${body.msg}` : ''}`);
const macCheck = body => (body?.ok === true ? null : 'NOT_OK');

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
  constructor({ hub, store = null, barkUrl = '', barkSound = 'shake', barkCall = true, barkLevel = 'timeSensitive', barkVolume = 10, pushOnlySku = '', pushCooldownMs = 0, ntfyUrl = '', feishuUrl = '', feishuSecret = '', wecomUrl = '', pushplusToken = '', macListenerUrl = '', macListenerToken = '', maxAttempts = 4, timeoutMs = 6_000, maxQueue = 500, retryBaseMs = 500, now = () => Date.now() } = {}) {
    this.hub = hub;
    this.store = store;          // optional StateStore, for a durable outbox
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.queue = [];             // [{ key, channel, event, attempt }]
    this.inflight = new Map();   // key -> job, held while delivering or backing off
    this.pushOnlySku = pushOnlySku;
    this.pushCooldownMs = pushCooldownMs;
    this.now = now;
    // Push cooldown state. The window starts when a push is actually delivered (first channel
    // to succeed), not when it is queued, so a push that fails everywhere costs nothing.
    this.lastPushAt = 0;
    this.batch = null;           // { id, pending, delivered } — the gated push going out now
    this.deferred = [];          // arrivals held back by the window; merged and sent when it ends
    this.flushTimer = null;
    this.draining = false;
    this.deadLetter = [];
    this.lastError = null;

    this.channels = [];
    // BARK_URL may list several device URLs separated by commas — one channel each,
    // so every one of the user's devices rings for the same alert.
    const barkUrls = String(barkUrl).split(',').map((u) => u.trim()).filter(Boolean);
    for (const [index, oneBarkUrl] of barkUrls.entries()) {
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
      this.channels.push(new Channel(index === 0 ? 'bark' : `bark-${index + 1}`, oneBarkUrl.replace(/\/+$/, ''), (url, event) => ({
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: alertTitle,
            body: alertLine(event),
            url: 'applestore://',
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
          body: alertLine(event).replace(/\n/g, ' · ')
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
    if (macListenerUrl) {
      // Direct push to Leon's Mac Mini over his Tailscale network: the radar posts
      // to the listener on the Mac, which shows a native macOS notification. The
      // token gates the listener so a stray LAN request cannot trigger alerts.
      // Same push gate as Bark (send() filters before enqueueing), same outbox.
      this.channels.push(new Channel('mac', macListenerUrl, (url, event) => ({
        url,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: macListenerToken,
            title: '到货提醒',
            body: alertLine(event)
          })
        }
      }), macCheck, true));
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

    // External-push gate (see notifierOptionsFromEnv). The hub stream above is never gated.
    // A non-matching SKU never pushes (events without an sku, e.g. notify:test, pass).
    if (this.pushOnlySku && event.sku && event.sku !== this.pushOnlySku) return { streamed, queued: 0 };

    if (this.pushCooldownMs > 0) {
      // Inside the window (or while the previous push is still going out) an arrival is
      // HELD, never dropped: the monitor has already advanced its baseline past it, so a
      // dropped push is an arrival the user never hears about. Held arrivals go out merged.
      if (this.batch || this.now() - this.lastPushAt < this.pushCooldownMs) {
        this.deferred.push(event);
        this.persist();
        this.scheduleDeferred();
        return { streamed, queued: 0, deferred: this.deferred.length };
      }
      this.startBatch([event]);
      return { streamed, queued: this.queue.length };
    }

    this.enqueue(event);
    return { streamed, queued: this.queue.length };
  }

  /** One job per channel for one event. */
  enqueue(event) {
    for (const channel of this.channels) {
      if (this.queue.length >= this.maxQueue) {
        this.queue.shift();
        log.warn('notification queue full, dropped oldest');
      }
      this.queue.push({ key: Notifier.key(event, channel.name), channel: channel.name, event, attempt: 0 });
    }
    this.persist();
    this.drain();
  }

  /** Send a gated push (one arrival, or several merged) and track it until it settles. */
  startBatch(events) {
    const event = events.length === 1
      ? { ...events[0], id: events[0].id || `push-${this.now()}` }
      : mergeArrivals(events);
    this.batch = { id: event.id, pending: this.channels.length, delivered: false };
    this.enqueue(event);
  }

  /** Record one channel's final outcome for the gated push in flight. */
  settleBatch(job, delivered) {
    const batch = this.batch;
    if (!batch || job.event?.id !== batch.id) return;
    batch.pending -= 1;
    if (delivered && !batch.delivered) {
      batch.delivered = true;
      this.lastPushAt = this.now();
    }
    if (batch.pending > 0) return;
    this.batch = null;
    // Delivered: held arrivals wait out the window. Failed everywhere: the window was never
    // used, so held arrivals go out right away.
    this.scheduleDeferred();
  }

  scheduleDeferred() {
    if (!this.deferred.length || this.batch) return;
    const wait = Math.max(0, this.lastPushAt + this.pushCooldownMs - this.now());
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.batch || !this.deferred.length) return;
      if (this.now() - this.lastPushAt < this.pushCooldownMs) return this.scheduleDeferred();
      this.startBatch(this.deferred.splice(0));
    }, wait);
    this.flushTimer.unref?.();
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
        if (!channel) { this.settleBatch(job, false); continue; }   // channel removed by config change

        // Hold the job while it is being delivered or backing off. A job that is only
        // "in a local variable" is invisible to persist(), so a crash mid-backoff would
        // lose it — exactly the alert we promised to keep.
        this.inflight.set(job.key, job);
        this.persist();

        try {
          await channel.deliver(job.event, this.timeoutMs);
          channel.sent += 1;
          this.inflight.delete(job.key);
          this.settleBatch(job, true);
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
          this.settleBatch(job, false);
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
    this.store?.saveOutbox?.({ queue: this.pending(), deadLetter: this.deadLetter, deferred: this.deferred });
  }

  /** Reload a persisted outbox at startup and resume delivery. */
  restore() {
    const saved = this.store?.loadOutbox?.();
    if (!saved) return this;
    if (Array.isArray(saved.queue)) {
      this.queue = saved.queue.filter(job => job?.key && job?.channel && job?.event);
    }
    if (Array.isArray(saved.deadLetter)) this.deadLetter = saved.deadLetter;
    if (Array.isArray(saved.deferred)) this.deferred = saved.deferred.filter(Boolean);
    if (this.queue.length) {
      log.info('resuming persisted outbox', { pending: this.queue.length });
      this.drain();
    }
    if (this.deferred.length) {
      log.info('resuming held pushes', { held: this.deferred.length });
      this.scheduleDeferred();
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
      deferred: this.deferred.length,
      lastDeadLetterAt: this.deadLetter.at(-1)?.at || null,
      lastError: this.lastError
    };
  }
}
