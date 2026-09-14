import { mkdir, readFile, rename, copyFile, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.mjs';
import { catalog, productOfSku } from './catalog.mjs';

const log = logger.child({ mod: 'state' });

const SCHEMA_VERSION = 4;
const MAX_EVENTS = 2_000;
const MAX_RETRY_MS = 30_000;

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, seq: 0, watches: [], events: [], coverage: [], outbox: { queue: [], deadLetter: [] } };
}

/**
 * Durable JSON state with coalesced writes.
 *
 * Design notes:
 * - Writes are *debounced and coalesced*: the monitor mutates many watches per tick, and
 *   rewriting the whole file per mutation is O(n) disk churn for no benefit.
 * - Every write is atomic (tmp file -> fsync -> rename) so a crash mid-write cannot
 *   leave a truncated state file.
 * - A failed write must never poison later writes, which is why the chain always
 *   settles and errors are surfaced rather than swallowed into a rejected promise.
 * - Corrupt state is quarantined, not silently discarded.
 */
export class StateStore {
  constructor(filePath, { flushDebounceMs = 250, maxEvents = MAX_EVENTS, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.flushDebounceMs = flushDebounceMs;
    this.maxEvents = maxEvents;
    this.now = now;
    this.state = emptyState();

    this.dirty = false;
    this.writing = null;
    this.timer = null;
    this.closed = false;
    // `failing` is the current condition, `writeErrors` the history — health needs the former.
    this.stats = { writes: 0, writeErrors: 0, coalesced: 0, lastWriteMs: null, lastWriteAt: null, lastWriteError: null, failing: false, failStreak: 0 };
    this.retryAt = 0;             // wall-clock ms before which a background retry must not run

    this.bySession = new Map();   // sessionId -> Set<watch>
    this.byId = new Map();        // watchId -> watch
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    let raw = null;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      // Only a missing file means "first run". Anything else (EACCES after a run under
      // sudo, EISDIR, EIO) means the state exists but cannot be read — and writing a fresh
      // empty state here would atomically REPLACE it, erasing every watch and baseline.
      // Refusing to start costs nothing extra: with no state there is nothing to monitor.
      if (error?.code !== 'ENOENT') {
        log.error('state file unreadable, refusing to start', { file: this.filePath, error: error.message });
        const fatal = new Error(`STATE_UNREADABLE: ${error.message}`);
        fatal.code = 'STATE_UNREADABLE';
        fatal.cause = error;
        throw fatal;
      }
      await this.flushNow();
      return this;
    }

    try {
      const parsed = JSON.parse(raw);
      this.state = {
        schemaVersion: SCHEMA_VERSION,
        seq: Number(parsed.seq) || 0,
        watches: Array.isArray(parsed.watches) ? parsed.watches : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        coverage: Array.isArray(parsed.coverage) ? parsed.coverage : [],
        outbox: parsed.outbox && typeof parsed.outbox === 'object'
          ? { queue: parsed.outbox.queue || [], deadLetter: parsed.outbox.deadLetter || [] }
          : { queue: [], deadLetter: [] }
      };
      this.migrate(Number(parsed.schemaVersion) || 1);
    } catch (error) {
      // Never start from a half-parsed file: quarantine it so the data is recoverable.
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        await copyFile(this.filePath, quarantine);
      } catch (copyError) {
        // Resetting is only safe once a copy exists; otherwise the reset destroys the data.
        log.error('state file corrupt and could not be quarantined, refusing to start', { error: copyError.message });
        const fatal = new Error(`STATE_QUARANTINE_FAILED: ${copyError.message}`);
        fatal.code = 'STATE_QUARANTINE_FAILED';
        fatal.cause = copyError;
        throw fatal;
      }
      log.error('state file corrupt, quarantined and reset', { quarantine, error: error.message });
      this.state = emptyState();
      await this.flushNow();
    }

    this.reindex();
    return this;
  }

  /** Forward-migrate older on-disk shapes. */
  migrate(fromVersion) {
    if (fromVersion >= SCHEMA_VERSION) return;
    for (const watch of this.state.watches) {
      watch.alertedAt = watch.alertedAt || {};
      watch.consecutiveErrors = watch.consecutiveErrors || 0;
      // v1/v2 predate multi-product. Recover the product from the SKU where possible;
      // fall back to the default so a legacy watch is never orphaned.
      if (!watch.product) {
        const product = productOfSku(watch.sku);
        watch.product = product?.id || catalog.defaultProduct;
        watch.productName = watch.productName || product?.name || null;
      }
      // v3 carried an 年年焕新 block; the feature is gone, so drop it rather than
      // leaving dead state that a future reader might treat as meaningful.
      delete watch.upgrade;
    }
    // v1 events predate monotonic sequencing; backfill so SSE replay stays ordered.
    this.state.events.forEach((event, index) => { if (!event.seq) event.seq = index + 1; });
    this.state.seq = Math.max(this.state.seq, this.state.events.length);
    // Persist the migrated shape right away. Migration is idempotent, so a lost write
    // costs nothing but correctness of the on-disk version marker — and a file that
    // reports v3 while a v4 process is running is a needless source of confusion.
    this.touch();
    log.info('state migrated', { from: fromVersion, to: SCHEMA_VERSION });
  }

  reindex() {
    this.bySession.clear();
    this.byId.clear();
    for (const watch of this.state.watches) {
      this.byId.set(watch.id, watch);
      if (watch.enabled === false) continue;
      if (!this.bySession.has(watch.sessionId)) this.bySession.set(watch.sessionId, new Set());
      this.bySession.get(watch.sessionId).add(watch);
    }
  }

  /** Mark state dirty; the actual write is debounced and coalesced. */
  touch() {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) { this.stats.coalesced += 1; return; }
    // While the disk is failing, background retries back off instead of re-firing every
    // debounce period. Mutations keep landing in memory meanwhile; explicit flushNow()
    // (shutdown) still writes immediately.
    const delay = Math.max(this.flushDebounceMs, this.retryAt - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.flushNow().catch(() => {}); }, delay);
    this.timer.unref?.();
  }

  /** Atomic durable write. Serialized, and a failure never blocks future writes. */
  async flushNow() {
    if (this.writing) return this.writing;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    const run = (async () => {
      const started = Date.now();
      this.dirty = false;
      const tmp = `${this.filePath}.tmp`;
      try {
        const payload = JSON.stringify(this.state);
        const handle = await open(tmp, 'w');
        try {
          await handle.writeFile(payload, 'utf8');
          await handle.sync();           // durability: survive power loss, not just crash
        } finally {
          await handle.close();
        }
        await rename(tmp, this.filePath);
        this.stats.writes += 1;
        this.stats.lastWriteMs = Date.now() - started;
        this.stats.lastWriteAt = new Date(this.now()).toISOString();
        if (this.stats.failStreak) log.info('state flush recovered', { failedAttempts: this.stats.failStreak });
        this.stats.failing = false;
        this.stats.failStreak = 0;
        this.retryAt = 0;
      } catch (error) {
        const repeated = this.stats.failing && this.stats.lastWriteError === error.message;
        this.stats.writeErrors += 1;
        this.stats.failStreak += 1;
        this.stats.failing = true;
        this.stats.lastWriteError = error.message;
        this.dirty = true;                // keep the change pending for the next attempt
        this.retryAt = Date.now() + Math.min(MAX_RETRY_MS, this.flushDebounceMs * 2 ** this.stats.failStreak);
        // One line per distinct failure, then a periodic reminder — not one per attempt.
        if (!repeated) log.error('state flush failed', { error: error.message });
        else if (this.stats.failStreak % 20 === 0) log.warn('state flush still failing', { error: error.message, attempts: this.stats.failStreak });
        // Background (debounced) flushes must not crash the process, but the caller of
        // an explicit flush has to be able to find out. `flushNow` resolves to a result
        // instead of throwing, so both paths can be handled deliberately.
        return { ok: false, error: error.message };
      }
      return { ok: true };
    })();

    this.writing = run;
    try { return await run; }
    finally {
      this.writing = null;
      // A mutation that landed mid-write still needs persisting.
      if (this.dirty && !this.closed) this.touch();
    }
  }

  /**
   * Flush and stop accepting writes.
   *
   * Throws when the final write failed. Losing state on shutdown is not a cosmetic
   * problem: watch baselines live here, and a lost baseline means the next run treats
   * already-available stock as a fresh baseline and never alerts on it. The caller must
   * be able to exit non-zero so a supervisor notices.
   */
  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const result = await this.flushNow();
    this.closed = true;
    if (result && result.ok === false) {
      const error = new Error(`STATE_FLUSH_FAILED: ${result.error}`);
      error.code = 'STATE_FLUSH_FAILED';
      throw error;
    }
    return result;
  }

  // ---- watches -------------------------------------------------------------

  listWatches(sessionId) {
    return [...(this.bySession.get(sessionId) || [])];
  }

  allWatches() {
    return this.state.watches.filter(w => w.enabled !== false);
  }

  findWatch(sessionId, { sku, region }) {
    return this.listWatches(sessionId).find(w => w.sku === sku && w.region === region) || null;
  }

  /** Active watches grouped by product, for per-product phase gating and UI. */
  watchesByProduct() {
    const map = new Map();
    for (const watch of this.allWatches()) {
      const id = watch.product || catalog.defaultProduct;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(watch);
    }
    return map;
  }

  getWatch(id) {
    const watch = this.byId.get(id);
    return watch && watch.enabled !== false ? watch : null;
  }

  createWatch(sessionId, input) {
    const existing = this.findWatch(sessionId, input);
    if (existing) return existing;
    const iso = new Date(this.now()).toISOString();
    const watch = {
      id: randomUUID(),
      sessionId,
      enabled: true,
      createdAt: iso,
      updatedAt: iso,
      lastCheckedAt: null,
      lastStates: null,
      alertedAt: {},
      consecutiveErrors: 0,
      ...input
    };
    this.state.watches.push(watch);
    this.byId.set(watch.id, watch);
    if (!this.bySession.has(sessionId)) this.bySession.set(sessionId, new Set());
    this.bySession.get(sessionId).add(watch);
    this.touch();
    return watch;
  }

  deleteWatch(sessionId, id) {
    const watch = this.byId.get(id);
    if (!watch || watch.sessionId !== sessionId || watch.enabled === false) return false;
    watch.enabled = false;
    watch.updatedAt = new Date(this.now()).toISOString();
    this.bySession.get(sessionId)?.delete(watch);
    this.touch();
    return true;
  }

  updateWatchSnapshot(id, states, checkedAt = new Date(this.now()).toISOString()) {
    const watch = this.getWatch(id);
    if (!watch) return null;
    watch.lastStates = states;
    watch.lastCheckedAt = checkedAt;
    watch.updatedAt = checkedAt;
    watch.consecutiveErrors = 0;
    this.touch();
    return watch;
  }

  /** One-shot flag: a pre-armed watch consumes it on its first successful reading. */
  clearArmedFlag(id) {
    const watch = this.getWatch(id);
    if (!watch?.armedBeforeLaunch) return null;
    delete watch.armedBeforeLaunch;
    this.touch();
    return watch;
  }

  markWatchError(id, reason) {
    const watch = this.getWatch(id);
    if (!watch) return null;
    watch.consecutiveErrors = (watch.consecutiveErrors || 0) + 1;
    watch.lastError = reason;
    watch.lastErrorAt = new Date(this.now()).toISOString();
    this.touch();
    return watch;
  }

  /** Alert de-dup clock, per (watch, store). */
  lastAlertAt(watchId, storeId) {
    return this.getWatch(watchId)?.alertedAt?.[storeId] || 0;
  }

  recordAlert(watchId, storeId, at = this.now()) {
    const watch = this.getWatch(watchId);
    if (!watch) return;
    watch.alertedAt = watch.alertedAt || {};
    watch.alertedAt[storeId] = at;
    this.touch();
  }

  // ---- events --------------------------------------------------------------

  listEvents(sessionId, limit = 30) {
    const rows = [];
    for (let i = this.state.events.length - 1; i >= 0 && rows.length < limit; i -= 1) {
      if (this.state.events[i].sessionId === sessionId) rows.push(this.state.events[i]);
    }
    return rows;
  }

  /** Events after a given sequence number — powers SSE `Last-Event-ID` replay. */
  eventsSince(sessionId, seq, limit = 50) {
    if (!Number.isFinite(seq)) return [];
    return this.state.events
      .filter(event => event.sessionId === sessionId && event.seq > seq)
      .slice(0, limit);
  }

  addEvent(event) {
    this.state.seq += 1;
    const stored = { id: randomUUID(), seq: this.state.seq, createdAt: new Date(this.now()).toISOString(), ...event };
    this.state.events.push(stored);
    if (this.state.events.length > this.maxEvents) {
      this.state.events = this.state.events.slice(-this.maxEvents);
    }
    this.touch();
    return stored;
  }

  // ---- coverage graph ------------------------------------------------------

  /** Durable notification outbox: survives restart so a mid-retry alert is not lost. */
  saveOutbox(outbox) {
    this.state.outbox = {
      queue: (outbox?.queue || []).map(({ key, channel, event, attempt }) => ({ key, channel, event, attempt })),
      deadLetter: outbox?.deadLetter || []
    };
    this.touch();
  }

  loadOutbox() {
    return this.state.outbox || { queue: [], deadLetter: [] };
  }

  saveCoverage(rows) {
    this.state.coverage = rows;
    this.touch();
  }

  loadCoverage() {
    return this.state.coverage || [];
  }

  stats_() { return this.stats; }

  statsSnapshot() {
    const active = this.allWatches();
    return {
      activeWatches: active.length,
      watchesByProduct: Object.fromEntries([...this.watchesByProduct()].map(([id, list]) => [id, list.length])),
      sessionsWithWatches: this.bySession.size,
      events: this.state.events.length,
      seq: this.state.seq,
      persistence: { ...this.stats, dirty: this.dirty }
    };
  }
}
