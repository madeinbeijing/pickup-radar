import { logger } from './logger.mjs';
import { getProduct, launchPhase, productOfSku } from './catalog.mjs';
import { LatencyWindow } from './notifier.mjs';

const log = logger.child({ mod: 'monitor' });

const MINUTE = 60_000;
const MAX_PACE_FACTOR = 32;
// How far past its due time a round may be (or how long one may run) before the scheduler
// counts as stalled. Generous on purpose: a laptop waking from sleep fires late once.
const STALL_GRACE_MS = 2 * MINUTE;
const MAX_ROUND_MS = 5 * MINUTE;
// Active polling cadences are measured from the start of a round, so a slow Apple response
// does not stretch a 3s cadence into 3s + latency. Never closer than this between rounds.
const ACTIVE_REASONS = new Set(['drop-window', 'recent-movement', 'steady-state']);
const MIN_ROUND_GAP_MS = 200;

/**
 * Adaptive stock monitor.
 *
 * Two ideas drive the design:
 *
 * 1. A round is planned *globally*, not per city. Every watch is folded into one
 *    region -> SKU map and handed to the coverage planner, so N watched cities cost
 *    far fewer than N upstream requests.
 *
 * 2. The poll interval is earned, not fixed. Polling every 30s at 04:00 three weeks
 *    after launch is pure waste; polling every 30s through a launch-morning drop is too
 *    slow. The cadence tracks launch phase, observed volatility and upstream health —
 *    the same shape of controller a production uptime monitor uses.
 */
export class StockMonitor {
  constructor({
    inventory,
    store,
    catalog,
    notifier,
    intervalMs = 30_000,
    minIntervalMs = 10_000,
    maxIntervalMs = 15 * MINUTE,
    quietMaxIntervalMs = MINUTE,
    alertCooldownMs = 2 * MINUTE,
    stats = null,
    now = () => Date.now()
  } = {}) {
    this.inventory = inventory;
    this.store = store;
    this.catalog = catalog;
    this.notifier = notifier;
    this.baseIntervalMs = Math.max(minIntervalMs, intervalMs);
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    // Ceiling for the quiet steady state only. maxIntervalMs still governs idle, pre-launch
    // and circuit-open sleeps, where nobody can be told about an arrival anyway.
    this.quietMaxIntervalMs = Math.max(this.baseIntervalMs, quietMaxIntervalMs);
    this.alertCooldownMs = alertCooldownMs;
    this.stats = stats;
    this.now = now;

    this.timer = null;
    this.stopped = true;
    // Operator pause: no rounds and no alerts until resumed. Distinct from `stopped`, which
    // is also true before start() and during shutdown and says nothing about intent.
    this.paused = false;
    this.pausedAt = null;
    this.running = false;
    this.abort = null;

    this.lastRunAt = null;
    this.lastRunMs = null;
    this.lastError = null;
    this.nextRunAt = null;
    this.currentIntervalMs = this.baseIntervalMs;
    this.lastTransitionAt = 0;
    this.createdAt = this.now();
    // Throttle-aware pacing: every throttled Apple response doubles the cadence, every clean
    // round afterwards halves it again (32x back to 1x in 5 clean rounds, not ~15). Apple publishes no rate limit,
    // so the monitor has to find the fastest pace it tolerates rather than guess one.
    this.pace = { factor: 1, seenThrottled: 0, seenSuccessAt: null };
    // Outcome of the last round that actually polled. queryPlan never throws — it degrades
    // to `unknown` — so `lastError` alone would stay clean while every watch goes blind.
    this.lastRound = null;
    this.failedRounds = 0;      // consecutive polling rounds in which no watch resolved
    this.counters = { ticks: 0, requests: 0, alerts: 0, suppressed: 0, errors: 0, watchesChecked: 0 };
    // Per arrival: time between the reading that showed stock and the reading before it.
    // The stock may have appeared anywhere in that gap, so it bounds detection delay.
    this.detectionGap = new LatencyWindow();
  }

  // ---- scheduling ----------------------------------------------------------

  /** Launch phase of one product. Products ship on independent schedules. */
  phase(productId) {
    return launchPhase(productId || this.catalog.defaultProduct, this.now());
  }

  /** Products that at least one watch is tracking. */
  watchedProducts() {
    const ids = new Set();
    for (const watch of this.store.allWatches()) ids.add(watch.product || this.catalog.defaultProduct);
    return [...ids];
  }

  /**
   * Next launch moment worth accelerating for, across watched products only.
   * Returns ms until that instant, or null when none is near.
   */
  nextDropDistance() {
    let nearest = null;
    for (const productId of this.watchedProducts()) {
      const product = getProduct(productId);
      if (!product) continue;
      for (const iso of [product.preorderAt, product.releaseAt]) {
        const distance = Date.parse(iso) - this.now();
        // A drop is "live" from 15 minutes before until 30 minutes after.
        if (distance > -30 * MINUTE && distance < 15 * MINUTE) {
          if (nearest === null || Math.abs(distance) < Math.abs(nearest)) nearest = distance;
        }
      }
    }
    return nearest;
  }

  /**
   * Choose the delay before the next round.
   * Returns the interval in ms; callers get the reason for observability.
   */
  /**
   * Fold what the upstream saw since the last round into the pace factor. Reads the
   * inventory's counters rather than this round's result, so a throttle triggered by a
   * page query slows the monitor too — Apple limits the IP, not the caller.
   */
  updatePace() {
    const throttled = this.inventory?.counters?.throttled ?? 0;
    const successAt = this.inventory?.upstream?.lastSuccessAt ?? null;
    const pace = this.pace;
    if (throttled > pace.seenThrottled) {
      pace.factor = Math.min(MAX_PACE_FACTOR, pace.factor * 2);
      log.warn('apple throttled, slowing down', { factor: pace.factor });
    } else if (successAt && successAt !== pace.seenSuccessAt && pace.factor > 1) {
      pace.factor = Math.max(1, pace.factor * 0.5);
    }
    pace.seenThrottled = throttled;
    pace.seenSuccessAt = successAt;
    return pace.factor;
  }

  /** Stretch an active-polling delay by the pace factor, never past maxIntervalMs. */
  paced(ms) {
    return Math.min(Math.max(ms, this.maxIntervalMs), Math.round(ms * this.pace.factor));
  }

  nextDelay() {
    const now = this.now();
    const watches = this.store.allWatches().length;
    if (!watches) return { ms: this.maxIntervalMs, reason: 'idle-no-watches' };

    const breaker = this.inventory.breaker;
    if (breaker.state === 'open') {
      // Respect the breaker rather than hammering a known-down upstream.
      const wait = Math.max(breaker.retryAfterMs(), this.baseIntervalMs);
      return { ms: Math.min(wait, this.maxIntervalMs), reason: 'circuit-open' };
    }

    // Hot window: minutes either side of any watched product's drop.
    if (this.nextDropDistance() !== null) {
      return { ms: this.paced(this.minIntervalMs), reason: 'drop-window' };
    }

    // If every watched product is still pre-launch there is nothing to find. Wake up
    // rarely, but keep a ceiling so the app is warm before the window opens.
    const live = this.watchedProducts().filter(id => this.phase(id) !== 'preorder-not-open');
    if (!live.length) {
      const soonest = Math.min(...this.watchedProducts()
        .map(id => Date.parse(getProduct(id)?.preorderAt || '') - now)
        .filter(Number.isFinite));
      const ms = Number.isFinite(soonest)
        ? Math.min(this.maxIntervalMs, Math.max(this.baseIntervalMs * 8, soonest / 4))
        : this.maxIntervalMs;
      return { ms, reason: 'pre-launch' };
    }

    // Recent movement means the shelf is live: stay close to base cadence.
    const sinceTransition = now - this.lastTransitionAt;
    if (this.lastTransitionAt && sinceTransition < 10 * MINUTE) {
      return { ms: this.paced(this.baseIntervalMs), reason: 'recent-movement' };
    }

    // Quiet upstream: widen gradually, but only to quietMaxIntervalMs. Apple never pushes,
    // so every step wider is detection delay for someone who is waiting.
    //
    // Quiet time is measured from startup at the earliest. lastTransitionAt lives in memory
    // and starts at 0, so without that floor a freshly restarted process would read as
    // "quiet for decades" and jump straight to the widest interval.
    const quietFor = now - Math.max(this.lastTransitionAt, this.createdAt);
    const quietFactor = Math.min(6, 1 + Math.floor(quietFor / (20 * MINUTE)));
    return { ms: this.paced(Math.min(this.quietMaxIntervalMs, this.baseIntervalMs * quietFactor)), reason: 'steady-state' };
  }

  /**
   * Delay before the next round, given how long the last one took. Active cadences count
   * from the round's start; idle, pre-launch and circuit-open sleeps are absolute waits.
   */
  afterRound(spentMs) {
    const next = this.nextDelay();
    if (!ACTIVE_REASONS.has(next.reason)) return next;
    return { ms: Math.max(MIN_ROUND_GAP_MS, next.ms - Math.max(0, spentMs)), reason: next.reason };
  }

  start() {
    if (!this.stopped || this.paused) return;
    this.stopped = false;
    this.schedule(1_000, 'startup');
  }

  schedule(ms, reason) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.currentIntervalMs = ms;
    this.nextRunAt = new Date(this.now() + ms).toISOString();
    this.scheduleReason = reason;
    this.timer = setTimeout(() => {
      const roundStartedAt = this.now();
      this.tick()
        .catch(error => log.error('tick failed', { error: error.message }))
        .finally(() => {
          this.updatePace();
          const next = this.afterRound(this.now() - roundStartedAt);
          this.schedule(next.ms, next.reason);
        });
    }, ms);
    this.timer.unref?.();
  }

  /**
   * Pull the next round forward.
   *
   * The cadence controller can legitimately park the monitor 15 minutes out (say, when
   * no watches exist). A watch created a second later must not wait out that sleep, so
   * any event that changes what is being monitored kicks the scheduler.
   */
  kick(reason = 'watch-changed', delayMs = 500) {
    if (this.stopped) return false;
    const nextAt = Date.parse(this.nextRunAt || '');
    if (Number.isFinite(nextAt) && nextAt - this.now() <= delayMs) return false;
    log.debug('scheduler kicked', { reason });
    this.schedule(delayMs, reason);
    return true;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.abort?.abort();
    // Let an in-flight round unwind so its state mutations are not lost.
    for (let i = 0; i < 50 && this.running; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  /**
   * Stop monitoring entirely until resume(): no rounds reach Apple and nothing alerts.
   *
   * Watches and their baselines are kept. A round already in flight is left to finish
   * rather than aborted — an aborted round degrades every watch to an error and would
   * leave a failing health verdict behind — but its readings are discarded unevaluated.
   */
  pause(at = this.now()) {
    if (this.paused) return false;
    this.paused = true;
    this.pausedAt = new Date(at).toISOString();
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.nextRunAt = null;
    this.scheduleReason = 'paused';
    log.info('monitor paused');
    return true;
  }

  /**
   * Resume after pause(). Baselines survived the pause, so a store that became available
   * meanwhile still alerts on the first round — the safe direction for a stock monitor.
   */
  resume() {
    if (!this.paused) return false;
    this.paused = false;
    this.pausedAt = null;
    // Round outcomes from before the pause describe a different moment; carrying them
    // over would keep health red until the first round after resuming.
    this.lastRound = null;
    this.lastError = null;
    this.failedRounds = 0;
    this.start();
    log.info('monitor resumed');
    return true;
  }

  // ---- one round -----------------------------------------------------------

  async tick() {
    // `stopped` gates *scheduling*, not explicit ticks: startup priming and tests call
    // tick() directly on a monitor that was never started.
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const started = Date.now();
    this.lastRunAt = new Date(this.now()).toISOString();
    this.lastError = null;
    this.counters.ticks += 1;

    try {
      // Only poll watches whose own product has opened. A pre-launch product has no
      // inventory to find, and querying it just burns upstream budget.
      const watches = this.store.allWatches()
        .filter(watch => this.phase(watch.product || this.catalog.defaultProduct) !== 'preorder-not-open');
      if (!watches.length) return;

      // Fold every watch into one region -> SKU plan.
      const regionSkus = new Map();
      for (const watch of watches) {
        if (!regionSkus.has(watch.region)) regionSkus.set(watch.region, new Set());
        regionSkus.get(watch.region).add(watch.sku);
      }
      const plan = new Map([...regionSkus].map(([region, skus]) => [region, [...skus]]));

      // A round counts only when it actually polls — idle or pre-launch ticks do not.
      this.stats?.count('monitorRounds');
      const before = this.inventory.counters.requests;
      const results = await this.inventory.queryPlan(plan, { signal: this.abort.signal });
      this.counters.requests += this.inventory.counters.requests - before;
      // Paused while the request was out: the readings stay unevaluated, so nothing alerts.
      if (this.paused) return;

      let checked = 0;
      let errored = 0;
      let firstError = null;
      for (const watch of watches) {
        const item = results.get(watch.region)?.[watch.sku];
        if (!item?.ok) {
          errored += 1;
          firstError = firstError || item?.error || 'UNKNOWN';
          this.counters.errors += 1;
          this.store.markWatchError(watch.id, item?.error || 'UNKNOWN');
          continue;
        }
        checked += 1;
        this.counters.watchesChecked += 1;
        this.evaluate(watch, item);
      }

      // A round where nothing resolved is invisible otherwise: queryPlan never throws,
      // it degrades to `unknown`. Surface it so a throttled or broken upstream is not
      // mistaken for a quiet one.
      this.lastRound = {
        at: new Date(this.now()).toISOString(), total: watches.length, checked, errored, reason: firstError
      };
      this.failedRounds = checked === 0 && errored > 0 ? this.failedRounds + 1 : 0;

      if (errored) {
        const level = checked === 0 ? 'warn' : 'debug';
        log[level]('round completed with errors', {
          checked, errored, total: watches.length, reason: firstError
        });
      }

      this.inventory.sweep();
      this.store.saveCoverage(this.inventory.planner.serialize());
    } catch (error) {
      this.lastError = error?.message || 'MONITOR_ERROR';
      log.error('monitor round failed', { error: this.lastError });
    } finally {
      this.lastRunMs = Date.now() - started;
      this.running = false;
      this.abort = null;
    }
  }

  /**
   * Check watches against fresh readings the moment they are fetched, not at the next round.
   *
   * Apple never pushes, but the monitor is not the only thing polling it: every page
   * refresh fetches too, and one request often harvests neighbouring cities in passing.
   * Wired to InventoryService#onFresh, those readings reach watches for free — no extra
   * upstream request. Rounds remain the guaranteed floor; this only makes detection earlier.
   */
  observe(readings) {
    if (this.paused) return;
    const byKey = new Map(readings.map(item => [`${item.sku}|${item.region}`, item]));
    for (const watch of this.store.allWatches()) {
      const item = byKey.get(`${watch.sku}|${watch.region}`);
      if (!item) continue;
      if (this.phase(watch.product || this.catalog.defaultProduct) === 'preorder-not-open') continue;
      this.evaluate(watch, item);
    }
  }

  /**
   * Compare a fresh reading against the stored baseline and alert on real arrivals.
   *
   * Rules, in order of importance:
   * - A watch with no baseline only records one. First sight is never an "arrival".
   * - Only a transition *into* `available` alerts. `unknown -> available` counts,
   *   because the store genuinely became buyable; `available -> available` does not.
   * - A per-(watch, store) cooldown damps flapping, so a store toggling around the
   *   boundary cannot spam the user.
   */
  evaluate(watch, item) {
    const baseline = watch.lastStates;
    // A store Apple did not report this time (absent from the response, or the SKU missing)
    // reads `unknown`. That says nothing about the shelf, so it must not overwrite the last
    // known state — otherwise available → unknown → available re-announces stock that never
    // left. A store never seen in a known state stays `unknown`, and its first real
    // `available` is still a genuine arrival.
    const nextStates = {};
    for (const store of item.stores) {
      const known = baseline?.[store.id];
      nextStates[store.id] = store.status === 'unknown' && known && known !== 'unknown' ? known : store.status;
    }
    const checkedAt = item.fetchedAt || new Date(this.now()).toISOString();

    if (!baseline) {
      // Normally first sight is not an arrival — it is just the starting point.
      //
      // A watch ARMED BEFORE LAUNCH is the exception. The user set it up while the
      // product could not be bought at all, so the first reading that shows stock is a
      // genuine arrival for them. Suppressing it would make "提前布控" pointless: the
      // one moment they armed it for is exactly the moment it would stay silent.
      if (watch.armedBeforeLaunch) {
        // The flag is spent on the first reading, so that reading has to be live. A stale
        // one could announce stock that is already gone; worse, adopting it as baseline
        // would silence the real arrival when the first fresh reading agrees with it.
        // Skip it untouched — the next fresh reading still alerts immediately.
        if (item.stale) {
          log.debug('pre-armed watch skipping stale first reading', { watch: watch.id, ageMs: item.staleAgeMs });
          return;
        }
        const available = item.stores.filter(store => store.status === 'available');
        for (const store of available) this.raise(watch, store, 'pre-launch', item, checkedAt);
        this.store.clearArmedFlag(watch.id);
        log.info('pre-armed watch first reading', {
          watch: watch.id, region: watch.region, available: available.length
        });
      } else {
        log.debug('baseline established', { watch: watch.id, region: watch.region, stores: item.stores.length });
      }
      this.store.updateWatchSnapshot(watch.id, nextStates, checkedAt);
      return;
    }

    // Rounds and observe() both feed this method, so readings can arrive out of order or
    // twice (a round re-reads what its own harvest already delivered). An older reading
    // would roll the baseline back and let the next one re-announce an arrival that was
    // already sent, so it is dropped. An equal timestamp is let through: two concurrent
    // requests can land in the same millisecond, and re-applying an identical reading is a
    // no-op because the baseline already matches it.
    if (watch.lastCheckedAt && Date.parse(checkedAt) < Date.parse(watch.lastCheckedAt)) return;

    // A stale reading describes the past; it must not manufacture a transition.
    if (item.stale) {
      log.debug('skipping stale reading', { watch: watch.id, ageMs: item.staleAgeMs });
      return;
    }

    for (const store of item.stores) {
      const previous = baseline[store.id] || 'unknown';
      if (store.status !== 'available' || previous === 'available') continue;

      const since = this.now() - this.store.lastAlertAt(watch.id, store.id);
      if (since < this.alertCooldownMs) {
        this.counters.suppressed += 1;
        log.debug('alert suppressed by cooldown', { watch: watch.id, store: store.id, sinceMs: since });
        continue;
      }

      this.raise(watch, store, previous, item, checkedAt);
    }

    // Baseline advances here for ALL stores, including ones whose alert was suppressed
    // by cooldown. That is correct *only* because cooldown means "already told them".
    //
    // CONTRACT for any future suppression rule: advancing the baseline discards the
    // transition permanently. Only advance past a store whose transition was actually
    // communicated. A rule that suppresses an alert the user never received must not
    // let the baseline move, or that arrival is lost for good.
    this.store.updateWatchSnapshot(watch.id, nextStates, checkedAt);
  }

  /** Record and dispatch one arrival. */
  raise(watch, store, previous, item, checkedAt) {
    const event = this.store.addEvent({
      type: 'stock_available',
      sessionId: watch.sessionId,
      watchId: watch.id,
      sku: watch.sku,
      capacity: watch.capacity,
      color: watch.color,
      colorLabel: watch.colorLabel,
      region: watch.region,
      regionLabel: watch.regionLabel,
      storeId: store.id,
      storeName: store.name,
      storeQuote: store.quote,
      previousStatus: previous,
      product: watch.product || this.catalog.defaultProduct,
      productName: watch.productName || productOfSku(watch.sku)?.name || 'iPhone',
      appleUrl: watch.appleUrl,
      fetchedAt: checkedAt,
      previousCheckedAt: watch.lastCheckedAt || null
    });
    this.detectionGap.add(Date.parse(checkedAt) - Date.parse(watch.lastCheckedAt || ''));

    this.store.recordAlert(watch.id, store.id, this.now());
    this.lastTransitionAt = this.now();
    this.counters.alerts += 1;
    log.info('stock available', { region: watch.region, store: store.name, sku: watch.sku, from: previous });
    this.notifier.send(event);
    return event;
  }

  /**
   * Whether the scheduling loop is dead. A monitor whose timer chain broke looks exactly
   * like a quiet one from the outside — no errors, no alerts — so it has to be derived
   * from time: a round that is long overdue, or one that never finishes.
   */
  stalled() {
    if (this.stopped) return false;
    const now = this.now();
    if (this.running) return now - Date.parse(this.lastRunAt || '') > MAX_ROUND_MS;
    const dueAt = Date.parse(this.nextRunAt || '');
    return Number.isFinite(dueAt) && now - dueAt > STALL_GRACE_MS;
  }

  health() {
    const phases = Object.fromEntries(
      Object.keys(this.catalog.products).map(id => [id, this.phase(id)])
    );
    return {
      phases,
      watchedProducts: this.watchedProducts(),
      intervalMs: this.currentIntervalMs,
      intervalReason: this.scheduleReason || null,
      baseIntervalMs: this.baseIntervalMs,
      paceFactor: Math.round(this.pace.factor * 100) / 100,
      running: this.running,
      stopped: this.stopped,
      paused: this.paused,
      pausedAt: this.pausedAt,
      lastRunAt: this.lastRunAt,
      lastRunMs: this.lastRunMs,
      nextRunAt: this.nextRunAt,
      lastError: this.lastError,
      lastRound: this.lastRound,
      failedRounds: this.failedRounds,
      stalled: this.stalled(),
      detectionGapMs: this.detectionGap.snapshot(),
      counters: { ...this.counters }
    };
  }
}

export { EventHub, Notifier } from './notifier.mjs';
