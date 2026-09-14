import { CircuitBreaker, Semaphore, TokenBucket, mapPool } from './resilience.mjs';
import { CoveragePlanner } from './coverage.mjs';
import { fetchJson, UpstreamError } from './upstream.mjs';
import { logger } from './logger.mjs';

const log = logger.child({ mod: 'inventory' });

const DEFAULTS = {
  freshTtlMs: 12_000,
  staleTtlMs: 10 * 60_000,
  timeoutMs: 7_000,
  retries: 2,
  failureThreshold: 4,
  circuitOpenMs: 20_000,
  maxPartsPerRequest: 16,
  maxConcurrency: 3,
  burst: 6,
  refillPerSec: 1.5
};

const ENDPOINT = 'https://www.apple.com.cn/shop/retail/pickup-message';
const STATUS_RANK = { available: 0, unavailable: 1, ineligible: 2, unknown: 3 };

export function normalizeStatus(value) {
  if (value === 'available') return 'available';
  if (value === 'unavailable') return 'unavailable';
  if (value === 'ineligible') return 'ineligible';
  return 'unknown';
}

function quoteFor(part) {
  return part?.pickupSearchQuote
    || part?.messageTypes?.regular?.storePickupQuote
    || part?.messageTypes?.regular?.storePickupProductTitle
    || null;
}

/**
 * Parse one SKU out of an Apple pickup-message payload.
 * Throws rather than guessing: a schema change must never be read as "no stock".
 */
export function normalizeApplePayload(data, sku) {
  const stores = Array.isArray(data?.body?.stores) ? data.body.stores : null;
  if (!stores) throw new UpstreamError('APPLE_SCHEMA_CHANGED');

  let partSeen = false;
  const normalized = stores.map(store => {
    const part = store?.partsAvailability?.[sku];
    if (part) partSeen = true;
    return {
      id: store?.storeNumber || null,
      name: store?.storeName || 'Apple Store',
      city: store?.city || store?.storeCity || '',
      state: store?.state || store?.storeState || '',
      distance: Number.isFinite(Number(store?.storedistance)) ? Number(store.storedistance) : null,
      status: part ? normalizeStatus(part.pickupDisplay) : 'unknown',
      quote: part ? quoteFor(part) : 'Apple 响应中未包含该配置',
      title: part?.messageTypes?.regular?.storePickupProductTitle || null,
      rawStatus: part?.pickupDisplay || null,
      missingPart: !part,
      missingFromResponse: false
    };
  });

  if (stores.length > 0 && !partSeen) {
    const error = new UpstreamError('APPLE_PART_MISSING');
    error.sku = sku;
    throw error;
  }
  return normalized;
}

/**
 * Decide whether an HTTP 200 actually satisfies the contract this app depends on.
 *
 * The distinction that matters:
 *   - HARD failure  → the response is unusable for every requested SKU. That is an
 *                     upstream fault: it trips the breaker and shows up in health, so a
 *                     schema change surfaces within seconds instead of degrading every
 *                     lookup to `unknown` behind a green status.
 *   - PARTIAL       → some SKUs resolved, some did not. A genuinely delisted or not-yet
 *                     -released SKU looks exactly like this, so it must NOT trip the
 *                     breaker — but it is recorded and logged rather than ignored.
 *
 * An empty store list is treated as a hard failure: every anchor we send is a real store
 * number with searchNearby, so zero stores means the response shape changed, not that
 * China ran out of Apple Stores.
 */
export function validateContract(data, skus) {
  const stores = data?.body?.stores;
  if (!Array.isArray(stores)) {
    return { ok: false, error: 'APPLE_SCHEMA_CHANGED', warning: 'body.stores is not an array' };
  }
  if (stores.length === 0) {
    return { ok: false, error: 'APPLE_EMPTY_STORES', warning: 'anchored query returned zero stores' };
  }

  const storeIds = stores.map(store => store?.storeNumber).filter(Boolean);
  if (!storeIds.length) {
    return { ok: false, error: 'APPLE_SCHEMA_CHANGED', warning: 'no store carried a storeNumber' };
  }

  const requested = [...new Set(skus)].filter(Boolean);
  const resolved = requested.filter(sku => stores.some(store => store?.partsAvailability?.[sku]));
  if (requested.length && !resolved.length) {
    return {
      ok: false,
      error: 'APPLE_PART_MISSING',
      warning: `none of ${requested.length} requested SKU(s) present in partsAvailability`
    };
  }

  const missing = requested.filter(sku => !resolved.includes(sku));
  return {
    ok: true,
    partial: missing.length > 0,
    storeIds,
    resolvedSkus: resolved,
    missingSkus: missing,
    warning: missing.length ? `SKU not present in response: ${missing.join(', ')}` : null
  };
}

/** Project a cluster response onto one region's expected store list. */
export function reconcileRegionStores(returnedStores, regionInfo) {
  const returnedById = new Map(returnedStores.filter(s => s.id).map(s => [s.id, s]));

  const expected = regionInfo.stores.map(store => {
    const hit = returnedById.get(store.id);
    if (hit) return { ...hit, name: store.name || hit.name, city: hit.city || regionInfo.label };
    return {
      id: store.id,
      name: store.name,
      city: regionInfo.label,
      state: '',
      distance: null,
      status: 'unknown',
      quote: '本次 Apple 响应未包含此门店',
      title: null,
      rawStatus: null,
      missingPart: false,
      missingFromResponse: true
    };
  });

  return expected.sort((a, b) => {
    const byStatus = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (byStatus) return byStatus;
    if (a.distance == null && b.distance != null) return 1;
    if (a.distance != null && b.distance == null) return -1;
    return (a.distance ?? 999) - (b.distance ?? 999);
  });
}

export class InventoryService {
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    this.fetchImpl = options.fetchImpl || fetch;
    this.catalog = options.catalog;
    this.now = options.now || (() => Date.now());

    this.cache = new Map();       // `sku|region` -> { at, value }
    this.inFlight = new Map();    // anchor request coalescing
    this.breaker = new CircuitBreaker({
      name: 'apple',
      failureThreshold: this.config.failureThreshold,
      openMs: this.config.circuitOpenMs,
      now: this.now
    });
    this.bucket = new TokenBucket({
      capacity: this.config.burst,
      refillPerSec: this.config.refillPerSec,
      now: this.now
    });
    this.gate = new Semaphore(this.config.maxConcurrency);
    this.planner = options.planner || new CoveragePlanner({ catalog: this.catalog, now: this.now });
    this.recorder = options.recorder || null;   // optional StatsRecorder
    this.freshListeners = new Set();            // see onFresh()

    this.upstream = { lastSuccessAt: null, lastLatencyMs: null, lastError: null, lastErrorAt: null, lastContractWarning: null, lastParseError: null };
    this.counters = { requests: 0, retries: 0, failures: 0, contractFailures: 0, contractWarnings: 0, parseErrors: 0, cacheHits: 0, staleServed: 0, harvested: 0, coalesced: 0 };
  }

  cacheKey(sku, regionId) { return `${sku}|${regionId}`; }

  freshItem(sku, regionId) {
    const hit = this.cache.get(this.cacheKey(sku, regionId));
    if (!hit) return null;
    const ageMs = this.now() - hit.at;
    if (ageMs >= this.config.freshTtlMs) return null;
    this.counters.cacheHits += 1;
    return { ...hit.value, cache: 'HIT', stale: false, cacheAgeMs: ageMs };
  }

  staleItem(sku, regionId) {
    const hit = this.cache.get(this.cacheKey(sku, regionId));
    if (!hit) return null;
    const ageMs = this.now() - hit.at;
    if (ageMs > this.config.staleTtlMs) return null;
    this.counters.staleServed += 1;
    return { ...hit.value, cache: 'STALE', stale: true, staleAgeMs: ageMs, cacheAgeMs: ageMs };
  }

  /** Drop cache entries that are past even the stale window, so memory stays bounded. */
  sweep() {
    const cutoff = this.now() - this.config.staleTtlMs;
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) { this.cache.delete(key); removed += 1; }
    }
    return removed;
  }

  buildUrl(anchor, skus) {
    const params = new URLSearchParams();
    params.set('pl', 'true');
    params.set('mts.0', 'regular');
    skus.forEach((sku, index) => params.set(`parts.${index}`, sku));
    params.set('store', anchor);
    // Without searchNearby the endpoint returns ONLY the anchor store, which would leave
    // every other store in the city permanently `unknown`.
    params.set('searchNearby', 'true');
    return `${ENDPOINT}?${params.toString()}`;
  }

  /**
   * One anchored cluster request. Rate limited, circuit broken, retried and coalesced.
   * Returns the raw normalized cluster plus the store ids observed.
   */
  async fetchCluster({ anchor, skus, signal }) {
    const key = `${anchor}|${[...skus].sort().join(',')}`;
    const pending = this.inFlight.get(key);
    if (pending) { this.counters.coalesced += 1; return pending; }

    const task = this.gate.run(async () => {
      if (!this.breaker.tryAcquire()) {
        throw new UpstreamError('CIRCUIT_OPEN', { retryable: false });
      }
      await this.bucket.acquire(signal);
      this.counters.requests += 1;
      this.recorder?.count('appleRequests');
      log.debug('upstream request', { anchor, skus: skus.length });

      try {
        const { data, latencyMs, attempts } = await fetchJson(this.buildUrl(anchor, skus), {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.config.timeoutMs,
          retries: this.config.retries,
          signal,
          onAttempt: ({ ok, attempt }) => { if (!ok && attempt > 0) this.counters.retries += 1; }
        });
        if (attempts > 1) {
          this.counters.retries += attempts - 1;
          this.recorder?.count('appleRetries', attempts - 1);
        }

        // A 200 with parseable JSON is NOT yet a success. Validate the contract we
        // actually depend on before telling the breaker and the health endpoint that
        // the upstream is fine — otherwise a schema change reads as "healthy" forever
        // while every lookup silently degrades to `unknown`.
        const contract = validateContract(data, skus);
        if (!contract.ok) {
          const error = new UpstreamError(contract.error, { retryable: false });
          error.contract = contract;
          throw error;
        }

        this.breaker.onSuccess();
        this.upstream = {
          lastSuccessAt: new Date(this.now()).toISOString(),
          lastLatencyMs: latencyMs,
          lastError: null,
          lastErrorAt: this.upstream.lastErrorAt,
          lastContractWarning: contract.partial ? contract.warning : null
        };
        if (contract.partial) {
          this.counters.contractWarnings += 1;
          log.warn('upstream contract partially unmet', { anchor, warning: contract.warning });
        }
        return { data, storeIds: contract.storeIds, latencyMs, fetchedAt: new Date(this.now()).toISOString() };
      } catch (error) {
        this.counters.failures += 1;
        this.recorder?.count('appleFailures');
        if (error?.contract) {
          this.counters.contractFailures += 1;
          log.error('upstream contract broken', { anchor, error: error.code, detail: error.contract.warning });
        }
        this.breaker.onFailure(error);
        this.upstream.lastError = error?.code || error?.message || 'UPSTREAM_ERROR';
        this.upstream.lastErrorAt = new Date(this.now()).toISOString();
        throw error;
      }
    });

    this.inFlight.set(key, task);
    try { return await task; }
    finally { this.inFlight.delete(key); }
  }

  /**
   * Store a cluster response into the cache for every region it fully covers — not just
   * the region that triggered the request. This is where the cross-city harvest happens.
   */
  harvest({ data, storeIds, fetchedAt, skus, anchor, regions = [] }) {
    const covered = this.planner.learn(anchor, storeIds);
    const written = [];
    const fresh = [];

    // Cache the regions this anchor fully covers (the harvest bonus) *and* the regions
    // this request was issued for. A region Apple answered only partially must still be
    // resolved — its absent stores become `unknown`, which is strictly better than
    // returning nothing at all for that city.
    const targets = new Set([...covered, ...regions.filter(id => this.catalog.regions[id])]);

    for (const regionId of targets) {
      const regionInfo = this.catalog.regions[regionId];
      if (!regionInfo) continue;
      for (const sku of skus) {
        let stores;
        try { stores = reconcileRegionStores(normalizeApplePayload(data, sku), regionInfo); }
        catch (error) {
          // Reaching here means the contract check passed for the batch but this one
          // SKU/region projection still failed. Never swallow it: an invisible parse
          // failure is how a monitor goes blind without anyone noticing.
          this.counters.parseErrors += 1;
          this.upstream.lastParseError = error?.code || error?.message || 'PARSE_ERROR';
          log.warn('projection failed for sku', { sku, region: regionId, error: this.upstream.lastParseError });
          continue;
        }
        const value = {
          source: 'apple.com.cn',
          sourceEndpoint: '/shop/retail/pickup-message',
          anchor,
          region: regionId,
          sku,
          fetchedAt,
          stores
        };
        this.cache.set(this.cacheKey(sku, regionId), { at: this.now(), value });
        // Statistics are fed here and only here: harvest sees fresh, contract-valid data,
        // so a cache hit or a stale fallback can never register as an arrival.
        this.recorder?.observe({ sku, regionId, stores, fetchedAt });
        written.push(`${sku}|${regionId}`);
        fresh.push(value);
      }
    }
    this.counters.harvested += Math.max(0, written.length - skus.length);
    this.emitFresh(fresh);
    return { covered, written };
  }

  /**
   * Subscribe to every fresh, contract-valid reading harvest() writes — whichever caller
   * paid for the request. Same guarantee as the stats feed: never a cache hit or stale
   * fallback. Returns an unsubscribe function.
   */
  onFresh(listener) {
    this.freshListeners.add(listener);
    return () => this.freshListeners.delete(listener);
  }

  emitFresh(readings) {
    if (!readings.length) return;
    for (const listener of this.freshListeners) {
      // A listener bug must never fail the query that happened to feed it.
      try { listener(readings); }
      catch (error) { log.error('fresh-reading listener failed', { error: error?.message }); }
    }
  }

  /**
   * Fetch a set of regions, each with its own SKU list, in as few upstream requests as
   * the coverage planner allows. Never throws: unreachable regions come back as
   * `{ ok:false, status:'unknown' }`, which callers must not treat as "out of stock".
   */
  async queryPlan(regionSkus, { signal } = {}) {
    const regionIds = [...regionSkus.keys()].filter(id => this.catalog.regions[id]);
    const result = new Map();
    const pending = new Set();

    // 1. Serve everything already fresh in cache.
    for (const regionId of regionIds) {
      const items = {};
      let complete = true;
      for (const sku of regionSkus.get(regionId)) {
        const fresh = this.freshItem(sku, regionId);
        if (fresh) items[sku] = { ok: true, ...fresh };
        else complete = false;
      }
      result.set(regionId, items);
      if (!complete) pending.add(regionId);
    }
    if (!pending.size) return result;

    // 2. Plan the minimum anchor set covering what is still missing.
    const batches = this.planner.plan([...pending]);
    const chunked = [];
    for (const batch of batches) {
      const union = new Set();
      for (const regionId of batch.regions) for (const sku of regionSkus.get(regionId) || []) union.add(sku);
      const skus = [...union];
      for (let i = 0; i < skus.length; i += this.config.maxPartsPerRequest) {
        chunked.push({ ...batch, skus: skus.slice(i, i + this.config.maxPartsPerRequest) });
      }
    }

    log.debug('plan built', { regions: pending.size, requests: chunked.length });

    // 3. Execute with bounded concurrency.
    const outcomes = await mapPool(chunked, this.config.maxConcurrency, async batch => {
      const cluster = await this.fetchCluster({ anchor: batch.anchor, skus: batch.skus, signal });
      const { covered } = this.harvest({ ...cluster, skus: batch.skus, anchor: batch.anchor });
      return { batch, covered };
    });

    // 4. Resolve each region from the freshly harvested cache, falling back to stale.
    const failedRegions = new Map();
    for (let i = 0; i < outcomes.length; i += 1) {
      const outcome = outcomes[i];
      if (outcome.ok) continue;
      for (const regionId of chunked[i].regions) {
        failedRegions.set(regionId, outcome.error?.code || outcome.error?.message || 'UPSTREAM_ERROR');
      }
    }

    for (const regionId of pending) {
      const items = result.get(regionId);
      for (const sku of regionSkus.get(regionId)) {
        if (items[sku]?.ok) continue;
        const hit = this.cache.get(this.cacheKey(sku, regionId));
        const ageMs = hit ? this.now() - hit.at : Infinity;
        if (hit && ageMs < this.config.freshTtlMs) {
          items[sku] = { ok: true, ...hit.value, cache: 'MISS', stale: false, cacheAgeMs: ageMs };
          continue;
        }
        const stale = this.staleItem(sku, regionId);
        const reason = failedRegions.get(regionId)
          || (this.breaker.state !== 'closed' ? 'CIRCUIT_OPEN' : 'COVERAGE_MISS');
        items[sku] = stale
          ? { ok: true, ...stale, degradedReason: reason }
          : { ok: false, error: reason, status: 'unknown' };
      }
    }

    return result;
  }

  /** Single (sku, region) lookup used by the request path. */
  async queryOne({ sku, regionId, signal } = {}) {
    const map = new Map([[regionId, [sku]]]);
    const plan = await this.queryPlan(map, { signal });
    const item = plan.get(regionId)?.[sku];
    if (!item?.ok) {
      const error = new UpstreamError(item?.error || 'UPSTREAM_ERROR');
      error.code = item?.error || 'UPSTREAM_ERROR';
      throw error;
    }
    return item;
  }

  health() {
    return {
      circuit: this.breaker.snapshot(),
      rateLimiter: this.bucket.snapshot(),
      concurrency: this.gate.snapshot(),
      coverage: this.planner.snapshot(),
      cacheEntries: this.cache.size,
      inFlight: this.inFlight.size,
      counters: { ...this.counters },
      upstream: this.upstream
    };
  }
}
