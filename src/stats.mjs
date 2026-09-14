import { mkdir, readFile, writeFile, appendFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.mjs';

const log = logger.child({ mod: 'stats' });

/**
 * Arrival statistics.
 *
 * What is measured, and why it is measured this way:
 *
 * Apple's pickup endpoint reports only available / unavailable per (SKU, store) — there is
 * no unit count. So "how much stock arrived" is expressed as TRANSITIONS: a store turning
 * available for a SKU is one arrival ("up"), turning unavailable again is one sell-out
 * ("down"), and the time between them is how long it stayed buyable.
 *
 * Rules:
 * - Keyed by (SKU, store), never by watch — ten people watching one config must not
 *   count one arrival ten times.
 * - `unknown` never changes state. A failed or partial read is not a sell-out; that is
 *   the same invariant the rest of the app is built on.
 * - First sight of an available store is a `baseline`, not an arrival: we did not see it
 *   arrive. It still counts toward "how many stores are available right now".
 * - Days are China Standard Time. At the first activity of a new day, every store still
 *   available is written as a `carry` line, so each day file is self-contained.
 * - Events are append-only JSONL, one file per day: cheap to write, trivially inspectable,
 *   and a torn final line on crash loses one event rather than the file.
 */

const CST_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;
const COUNTER_KEYS = ['monitorRounds', 'pageQueries', 'cacheHits', 'appleRequests', 'appleRetries', 'appleFailures'];

/** CST calendar day ("2026-09-18") of an instant. */
export function dayKey(ms) {
  return new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Instant of 00:00 CST for a day key. */
export function dayStart(key) {
  return Date.parse(`${key}T00:00:00+08:00`);
}

const emptyCounters = () => Object.fromEntries(COUNTER_KEYS.map(key => [key, 0]));

export class StatsRecorder {
  constructor({ dir, catalog, now = () => Date.now(), retentionDays = 30, flushDebounceMs = 2_000 } = {}) {
    this.dir = dir;
    this.catalog = catalog;
    this.now = now;
    this.retentionDays = retentionDays;
    this.flushDebounceMs = flushDebounceMs;

    this.state = new Map();      // `${sku}|${storeId}` -> { available, since, fresh }
    this.currentDay = null;
    this.countersDay = null;     // the day whose counters are actually held in memory
    this.counters = emptyCounters();
    this.firstObservedAt = null;
    this.lastObservedAt = null;

    this.chain = Promise.resolve();
    this.timer = null;
    this.closed = false;
    // `writeFailing` is the current condition (cleared by the next successful write);
    // `writeErrors` is history. Health needs the former, or one old error reads as forever.
    this.health = { appended: 0, writeErrors: 0, lastWriteError: null, writeFailing: false };
    this.skuIndex = this.buildSkuIndex();
  }

  buildSkuIndex() {
    const index = new Map();
    for (const product of Object.values(this.catalog.products)) {
      for (const [key, variant] of Object.entries(product.variants)) {
        const [capacity, color] = key.split(':');
        const colorLabel = product.colors.find(c => c.id === color)?.label || color;
        index.set(variant.sku, { product: product.id, productName: product.name, capacity, color, colorLabel });
      }
    }
    return index;
  }

  eventsFile(day) { return join(this.dir, `events-${day}.jsonl`); }
  countersFile(day) { return join(this.dir, `counters-${day}.json`); }
  stateFile() { return join(this.dir, 'state.json'); }

  // ---- lifecycle ----------------------------------------------------------

  async init() {
    await mkdir(this.dir, { recursive: true });
    const today = dayKey(this.now());

    let savedAt = 0;
    try {
      const saved = JSON.parse(await readFile(this.stateFile(), 'utf8'));
      savedAt = Number(saved.savedAt) || 0;
      for (const [key, [available, since]] of Object.entries(saved.keys || {})) {
        // `fresh: false` — we have not observed this key since the process started, so a
        // transition detected on its next reading may hide an unseen flip during downtime.
        this.state.set(key, { available: Boolean(available), since: Number(since), fresh: false });
      }
      if (saved.day) this.currentDay = saved.day;
    } catch { /* first run */ }

    // The snapshot is debounced; replay anything appended after it so state is exact.
    for (const event of await this.readEvents(today)) {
      if (Date.parse(event.t) <= savedAt) continue;
      const key = `${event.sku}|${event.storeId}`;
      if (event.type === 'down') this.state.set(key, { available: false, since: Date.parse(event.t), fresh: false });
      else this.state.set(key, { available: true, since: Date.parse(event.since || event.t), fresh: false });
    }

    try {
      const saved = JSON.parse(await readFile(this.countersFile(today), 'utf8'));
      this.counters = { ...emptyCounters(), ...saved.counters };
      this.firstObservedAt = saved.firstObservedAt || null;
      this.lastObservedAt = saved.lastObservedAt || null;
      this.currentDay = today;
      this.countersDay = today;
    } catch { /* no counters yet today */ }

    // Restarted today before any counters were written: today's counters legitimately
    // start at zero, and must be persisted from here on.
    if (this.currentDay === today && !this.countersDay) this.countersDay = today;

    await this.sweepOld().catch(error => log.warn('stats retention sweep failed', { error: error.message }));
    return this;
  }

  /** Called on every recorded activity; rolls the day over when the CST date changes. */
  rollover(atMs) {
    const day = dayKey(atMs);
    if (this.currentDay === day) return day;
    // Freeze the previous day's counters — but only if they are the ones in memory. A
    // process that starts on a new day holds empty counters; writing those under
    // yesterday's name would wipe yesterday's real numbers.
    if (this.countersDay && this.countersDay !== day) this.persistCounters(this.countersDay);
    this.currentDay = day;
    this.countersDay = day;
    this.counters = emptyCounters();
    this.firstObservedAt = null;
    this.lastObservedAt = null;

    // Seed the new day with every store that is still available, so its file stands alone.
    const startIso = new Date(dayStart(day)).toISOString();
    for (const [key, entry] of this.state) {
      if (!entry.available) continue;
      const [sku, storeId] = key.split('|');
      this.append(day, { t: startIso, type: 'carry', since: new Date(entry.since).toISOString(), ...this.describe(sku, storeId) });
    }
    return day;
  }

  describe(sku, storeId, regionId = null, storeName = null) {
    const meta = this.skuIndex.get(sku) || { product: null, productName: null, capacity: null, color: null, colorLabel: null };
    let region = regionId;
    let name = storeName;
    if (!region || !name) {
      for (const [id, info] of Object.entries(this.catalog.regions)) {
        const hit = info.stores.find(store => store.id === storeId);
        if (hit) { region = region || id; name = name || hit.name; break; }
      }
    }
    return { sku, storeId, storeName: name || storeId, region, ...meta };
  }

  // ---- recording ------------------------------------------------------------

  /** Count one unit of refresh activity (see COUNTER_KEYS). */
  count(key, amount = 1) {
    if (!COUNTER_KEYS.includes(key) || this.closed) return;
    this.rollover(this.now());
    this.counters[key] += amount;
    this.scheduleFlush();
  }

  /**
   * Feed one fresh upstream reading for (SKU, region). Only fresh, contract-valid data
   * should reach here — stale cache must never manufacture a transition.
   */
  observe({ sku, regionId, stores, fetchedAt }) {
    if (this.closed || !Array.isArray(stores)) return [];
    const t = Number.isFinite(Date.parse(fetchedAt)) ? Date.parse(fetchedAt) : this.now();
    const day = this.rollover(t);
    if (!this.firstObservedAt) this.firstObservedAt = new Date(t).toISOString();
    // Liveness: when the upstream was last actually read (not when the page was opened).
    if (!this.lastObservedAt || t > Date.parse(this.lastObservedAt)) this.lastObservedAt = new Date(t).toISOString();
    this.scheduleFlush();
    const emitted = [];

    for (const store of stores) {
      if (!store?.id) continue;
      if (store.status !== 'available' && store.status !== 'unavailable' && store.status !== 'ineligible') continue;
      const available = store.status === 'available';
      const key = `${sku}|${store.id}`;
      const previous = this.state.get(key);
      const meta = this.describe(sku, store.id, regionId, store.name);
      const iso = new Date(t).toISOString();

      if (!previous) {
        this.state.set(key, { available, since: t, fresh: true });
        if (available) emitted.push(this.append(day, { t: iso, type: 'baseline', ...meta }));
        continue;
      }
      if (previous.available === available) {
        previous.fresh = true;
        continue;
      }
      if (available) {
        emitted.push(this.append(day, { t: iso, type: 'up', uncertain: !previous.fresh || undefined, ...meta }));
      } else {
        emitted.push(this.append(day, {
          t: iso,
          type: 'down',
          since: new Date(previous.since).toISOString(),
          durationMs: t - previous.since,
          // Not observed since restart: the store may have flipped while we were down.
          uncertain: !previous.fresh || undefined,
          ...meta
        }));
      }
      this.state.set(key, { available, since: t, fresh: true });
    }

    if (emitted.length) this.scheduleFlush();
    return emitted;
  }

  append(day, event) {
    const line = JSON.stringify(event) + '\n';
    this.chain = this.chain
      .then(() => appendFile(this.eventsFile(day), line, 'utf8'))
      .then(() => { this.health.appended += 1; this.health.writeFailing = false; })
      .catch(error => {
        this.health.writeFailing = true;
        this.health.writeErrors += 1;
        this.health.lastWriteError = error.message;
        log.error('stats append failed', { error: error.message });
      });
    return event;
  }

  scheduleFlush() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.flushDebounceMs);
    this.timer.unref?.();
  }

  persistCounters(day) {
    if (day !== this.countersDay) return this.chain;
    const body = JSON.stringify({ day, counters: this.counters, firstObservedAt: this.firstObservedAt, lastObservedAt: this.lastObservedAt, savedAt: new Date(this.now()).toISOString() });
    const file = this.countersFile(day);
    this.chain = this.chain.then(() => atomicWrite(file, body)).then(() => { this.health.writeFailing = false; }).catch(error => {
      this.health.writeFailing = true;
      this.health.writeErrors += 1;
      this.health.lastWriteError = error.message;
      log.error('stats counters write failed', { error: error.message });
    });
    return this.chain;
  }

  /** Write counters + the state snapshot. Resolves to { ok } rather than throwing. */
  async flush() {
    const errorsBefore = this.health.writeErrors;
    if (this.countersDay) this.persistCounters(this.countersDay);
    const keys = {};
    for (const [key, entry] of this.state) keys[key] = [entry.available ? 1 : 0, entry.since];
    const body = JSON.stringify({ savedAt: this.now(), day: this.currentDay, keys });
    this.chain = this.chain.then(() => atomicWrite(this.stateFile(), body)).then(() => { this.health.writeFailing = false; }).catch(error => {
      this.health.writeFailing = true;
      this.health.writeErrors += 1;
      this.health.lastWriteError = error.message;
      log.error('stats state write failed', { error: error.message });
    });
    await this.chain;
    return this.health.writeErrors === errorsBefore ? { ok: true } : { ok: false, error: this.health.lastWriteError };
  }

  /** Final flush. Throws on failure so shutdown can exit non-zero. */
  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const result = await this.flush();
    this.closed = true;
    if (!result.ok) {
      const error = new Error(`STATS_FLUSH_FAILED: ${result.error}`);
      error.code = 'STATS_FLUSH_FAILED';
      throw error;
    }
  }

  async sweepOld() {
    const cutoff = dayKey(this.now() - this.retentionDays * DAY_MS);
    for (const name of await readdir(this.dir)) {
      const match = name.match(/^(?:events|counters)-(\d{4}-\d{2}-\d{2})\.json(?:l)?$/);
      if (match && match[1] < cutoff) await unlink(join(this.dir, name));
    }
  }

  // ---- reading --------------------------------------------------------------

  async readEvents(day) {
    // Appends are queued; wait for them so a read right after a transition includes it.
    await this.chain;
    let raw;
    try { raw = await readFile(this.eventsFile(day), 'utf8'); }
    catch { return []; }
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { log.warn('skipping unreadable stats line', { day }); }   // torn write on crash
    }
    return events;
  }

  async readCounters(day) {
    if (day === this.countersDay) return { counters: { ...this.counters }, firstObservedAt: this.firstObservedAt, lastObservedAt: this.lastObservedAt };
    try {
      const saved = JSON.parse(await readFile(this.countersFile(day), 'utf8'));
      return { counters: { ...emptyCounters(), ...saved.counters }, firstObservedAt: saved.firstObservedAt || null, lastObservedAt: saved.lastObservedAt || null };
    } catch {
      return { counters: emptyCounters(), firstObservedAt: null, lastObservedAt: null };
    }
  }

  async availableDays() {
    await this.chain;            // a day file created by a pending append must be listed
    const days = new Set();
    try {
      for (const name of await readdir(this.dir)) {
        const match = name.match(/^(?:events|counters)-(\d{4}-\d{2}-\d{2})\.json(?:l)?$/);
        if (match) days.add(match[1]);
      }
    } catch { /* no dir */ }
    if (this.currentDay) days.add(this.currentDay);
    return [...days].sort().reverse();
  }

  /**
   * Most recent arrival for a product on or before `beforeDay`, searching newest day first.
   * Lets an empty day still answer "when did stock last show up?".
   */
  async lastArrival(product, beforeDay = null) {
    const days = (await this.availableDays()).filter(day => !beforeDay || day <= beforeDay);
    for (const day of days) {
      const ups = (await this.readEvents(day)).filter(e => e.type === 'up' && e.product === product);
      if (ups.length) {
        const last = ups.reduce((a, b) => (Date.parse(b.t) > Date.parse(a.t) ? b : a));
        return { day, t: last.t, sku: last.sku, storeName: last.storeName, region: last.region, capacity: last.capacity, colorLabel: last.colorLabel };
      }
    }
    return null;
  }

  /** What is currently being tracked for a product: distinct configs, stores and cities. */
  coverage(product) {
    const configs = new Set(), stores = new Set(), regions = new Set();
    for (const key of this.state.keys()) {
      const [sku, storeId] = key.split('|');
      if (this.skuIndex.get(sku)?.product !== product) continue;
      configs.add(sku);
      stores.add(storeId);
      const region = this.describe(sku, storeId).region;
      if (region) regions.add(region);
    }
    return { configs: configs.size, stores: stores.size, regions: regions.size };
  }

  snapshot() {
    return { day: this.currentDay, trackedKeys: this.state.size, counters: { ...this.counters }, ...this.health };
  }
}

async function atomicWrite(file, body) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, file);
}

// ---- aggregation (pure) -----------------------------------------------------

/**
 * Turn a day's events into availability intervals.
 * An interval is open (`end: null`) when the store was still available at the window end.
 */
export function buildIntervals(events, windowStart) {
  const sorted = [...events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const open = new Map();
  const intervals = [];
  for (const event of sorted) {
    const key = `${event.sku}|${event.storeId}`;
    const t = Date.parse(event.t);
    if (event.type === 'down') {
      const current = open.get(key);
      if (current) {
        current.end = t;
        open.delete(key);
      } else {
        // Available since before this window with no carry line (e.g. first run): bound it.
        intervals.push({ event, start: Math.max(windowStart, Date.parse(event.since || event.t)), end: t, kind: 'carry' });
      }
      continue;
    }
    if (open.has(key)) continue;
    const interval = { event, start: event.type === 'carry' ? windowStart : t, end: null, kind: event.type };
    open.set(key, interval);
    intervals.push(interval);
  }
  return intervals;
}

const covers = (interval, t) => interval.start <= t && (interval.end === null || interval.end > t);

export function summarize({ day, events: allEvents, counters, firstObservedAt, product, now = Date.now(), catalog }) {
  const start = dayStart(day);
  const windowEnd = Math.min(start + DAY_MS, now);
  // Everything below describes ONE product, so every figure on the page shares a scope.
  // Refresh counters are global by nature and are passed through unchanged.
  const events = allEvents.filter(e => e.product === product);
  const intervals = buildIntervals(events, start);

  const ups = events.filter(e => e.type === 'up');
  const downs = events.filter(e => e.type === 'down');
  const certainDowns = downs.filter(e => !e.uncertain);
  const avgDurationMin = certainDowns.length
    ? certainDowns.reduce((sum, e) => sum + e.durationMs, 0) / certainDowns.length / 60_000
    : null;

  // Chart window: from the first hour anything was observed to the end of the window.
  const firstT = Math.min(
    firstObservedAt ? Date.parse(firstObservedAt) : Infinity,
    ...allEvents.map(e => Date.parse(e.t))
  );
  const hasData = Number.isFinite(firstT);
  const chartStart = hasData ? Math.max(start, Math.floor((firstT - start) / 3600_000) * 3600_000 + start) : start;

  // Peak concurrency over 5-minute samples (all products).
  let peak = { value: 0, t: null };
  if (hasData) {
    for (let t = chartStart; t <= windowEnd; t += 5 * 60_000) {
      const value = intervals.filter(iv => covers(iv, t)).length;
      if (value > peak.value) peak = { value, t: new Date(t).toISOString() };
    }
  }

  const productInfo = catalog.products[product];

  // Config ranking by arrivals.
  const byConfig = new Map();
  for (const e of ups) {
    const key = e.sku;
    if (!byConfig.has(key)) byConfig.set(key, { sku: e.sku, product: e.product, productName: e.productName, capacity: e.capacity, colorLabel: e.colorLabel, swatch: null, ups: 0, stores: new Set(), lastUp: null, durations: [] });
    const row = byConfig.get(key);
    row.ups += 1;
    row.stores.add(e.storeId);
    if (!row.lastUp || e.t > row.lastUp) row.lastUp = e.t;
  }
  for (const e of certainDowns) byConfig.get(e.sku)?.durations.push(e.durationMs);
  const ranking = [...byConfig.values()]
    .map(r => ({
      sku: r.sku, product: r.product, productName: r.productName, capacity: r.capacity, colorLabel: r.colorLabel,
      ups: r.ups, stores: r.stores.size, lastUp: r.lastUp, swatch: r.swatch,
      avgDurationMin: r.durations.length ? r.durations.reduce((a, b) => a + b, 0) / r.durations.length / 60_000 : null
    }))
    .sort((a, b) => b.ups - a.ups || String(a.sku).localeCompare(String(b.sku)));

  const products = [...new Set(allEvents.map(e => e.product).filter(Boolean))];

  // Arrivals and sell-outs per CST hour, overall and per SKU (for drill-down).
  const hourOfDay = e => Math.min(23, Math.max(0, Math.floor((Date.parse(e.t) - start) / 3_600_000)));
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, up: 0, down: 0 }));
  const hourlyUpBySku = {};
  for (const e of events) {
    if (e.type !== 'up' && e.type !== 'down') continue;
    const h = hourOfDay(e);
    hourly[h][e.type] += 1;
    if (e.type === 'up') (hourlyUpBySku[e.sku] ||= Array(24).fill(0))[h] += 1;
  }
  const hourRange = hasData
    ? { from: Math.floor((chartStart - start) / 3_600_000), to: Math.min(23, Math.floor((windowEnd - 1 - start) / 3_600_000)) }
    : { from: 0, to: 0 };

  const colors = productInfo ? Object.fromEntries(productInfo.colors.map(c => [c.id, c.swatch])) : {};
  const openNow = intervals.filter(iv => iv.end === null);

  return {
    day,
    hasData,
    window: { start: new Date(chartStart).toISOString(), end: new Date(windowEnd).toISOString() },
    counters,
    totals: {
      ups: ups.length,
      downs: downs.length,
      baselines: events.filter(e => e.type === 'baseline').length,
      uncertain: events.filter(e => e.uncertain).length,
      stores: new Set(ups.map(e => e.storeId)).size,
      availableNow: openNow.length,
      storesAvailableNow: new Set(openNow.map(iv => iv.event.storeId)).size,
      peak,
      avgDurationMin
    },
    product,
    products,
    hourly,
    hourlyUpBySku,
    hourRange,
    ranking: ranking.map(r => ({ ...r, swatch: colors[events.find(e => e.sku === r.sku)?.color] || null }))
  };
}

/** Ledger rows for the detail view, newest first, with same-city context. */
export function ledger({ day, events, filters = {}, limit = 200, before = null }) {
  const start = dayStart(day);
  const intervals = buildIntervals(events, start);
  const beforeT = before ? Date.parse(before) : Infinity;

  const rows = events
    .filter(e => e.type === 'up' || e.type === 'down')
    .filter(e => !filters.product || e.product === filters.product)
    .filter(e => !filters.region || e.region === filters.region)
    .filter(e => !filters.type || e.type === filters.type)
    .filter(e => !filters.capacity || e.capacity === filters.capacity)
    .filter(e => !filters.sku || e.sku === filters.sku)
    .filter(e => filters.hour == null || Math.floor((Date.parse(e.t) - start) / 3_600_000) === filters.hour)
    .sort((a, b) => Date.parse(b.t) - Date.parse(a.t) || (a.type === 'down' ? -1 : 1));

  const total = rows.length;
  const page = rows.filter(e => Date.parse(e.t) < beforeT).slice(0, limit);

  // Per-hour totals over the WHOLE filtered set, not the loaded page — a group header
  // counting only the first 200 rows would understate its hour.
  const hourCounts = {};
  for (const e of rows) {
    const hour = Math.floor((Date.parse(e.t) - start) / 3_600_000);
    hourCounts[hour] = hourCounts[hour] || { up: 0, down: 0 };
    hourCounts[hour][e.type] += 1;
  }

  const out = page.map(e => {
    const t = Date.parse(e.t);
    const sameCity = intervals.filter(iv =>
      iv.event.sku === e.sku && iv.event.region === e.region && covers(iv, t)
    ).length;
    const closing = e.type === 'up' ? intervals.find(iv => iv.event === e) : null;
    return {
      ...e,
      // For an arrival, how long that window lasted (null while still available).
      windowMs: closing ? (closing.end === null ? null : closing.end - closing.start) : e.durationMs,
      sameCityAvailable: sameCity
    };
  });

  return {
    total,
    hourCounts,
    rows: out,
    nextBefore: page.length === limit ? page[page.length - 1].t : null
  };
}
