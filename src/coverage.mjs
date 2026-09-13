/**
 * Coverage planner.
 *
 * Apple's pickup-message endpoint anchored at `store=<id>&searchNearby=true` returns a
 * *cluster* of nearby stores, which routinely spans several cities (a Shanghai anchor
 * also returns Suzhou, Wuxi, Ningbo and Hangzhou). Polling city-by-city therefore
 * re-fetches the same stores many times over.
 *
 * This planner treats a monitoring round as a weighted set-cover problem: choose the
 * fewest anchors whose observed clusters cover every watched region. Greedy set cover
 * is the classic ln(n)-approximation and is more than good enough at this scale.
 *
 * Safety rule: a region counts as covered by an anchor only when *every* store of that
 * region was actually observed in that anchor's response. A wrong guess can only ever
 * produce `unknown` (never a false "out of stock"), and the planner corrects itself on
 * the next round from observed data.
 */

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class CoveragePlanner {
  constructor({ catalog, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.catalog = catalog;
    this.ttlMs = ttlMs;
    this.now = now;
    /** anchorStoreId -> { storeIds:Set, at:number, regions:Set } */
    this.observed = new Map();
    this.stats = { plans: 0, anchorsPlanned: 0, regionsPlanned: 0, misses: 0 };
  }

  /** Every store id that belongs to a region, from the static catalog. */
  regionStoreIds(regionId) {
    const region = this.catalog.regions[regionId];
    return region ? region.stores.map(store => store.id) : [];
  }

  /** Record which stores an anchor actually returned. */
  learn(anchorId, returnedStoreIds) {
    const storeIds = new Set(returnedStoreIds.filter(Boolean));
    const regions = new Set();
    for (const regionId of Object.keys(this.catalog.regions)) {
      const ids = this.regionStoreIds(regionId);
      if (ids.length && ids.every(id => storeIds.has(id))) regions.add(regionId);
    }
    this.observed.set(anchorId, { storeIds, regions, at: this.now() });
    return regions;
  }

  /** Regions an anchor is currently known to fully cover (empty once the entry expires). */
  coverageOf(anchorId) {
    const entry = this.observed.get(anchorId);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttlMs) {
      this.observed.delete(anchorId);
      return null;
    }
    return entry.regions;
  }

  /**
   * Candidate anchors: each region's own seed store. Anchoring only at known store
   * numbers keeps every request a valid Apple query.
   */
  candidates(regionIds) {
    const seen = new Map();
    for (const regionId of regionIds) {
      const region = this.catalog.regions[regionId];
      if (!region?.seedStore) continue;
      if (!seen.has(region.seedStore)) seen.set(region.seedStore, regionId);
    }
    return seen;
  }

  /**
   * Greedy set cover over the requested regions.
   * Returns [{ anchor, regions:[...], observed:boolean }].
   */
  plan(regionIds) {
    const remaining = new Set(regionIds.filter(id => this.catalog.regions[id]));
    const candidates = this.candidates(remaining);
    const batches = [];

    while (remaining.size) {
      let best = null;

      for (const [anchor, homeRegion] of candidates) {
        // Prior: an anchor always covers its own region. Learned data can only widen this.
        const learned = this.coverageOf(anchor);
        const covers = new Set(learned ? [...learned] : []);
        if (remaining.has(homeRegion)) covers.add(homeRegion);

        const gain = [...covers].filter(id => remaining.has(id));
        if (!gain.length) continue;
        // Prefer bigger gain; break ties toward anchors with confirmed observations.
        const score = gain.length * 10 + (learned ? 1 : 0);
        if (!best || score > best.score) best = { anchor, gain, score, observed: Boolean(learned) };
      }

      if (!best) {
        // No candidate can help (regions without a seed store) — emit them individually.
        for (const regionId of remaining) {
          const region = this.catalog.regions[regionId];
          if (region?.seedStore) batches.push({ anchor: region.seedStore, regions: [regionId], observed: false });
        }
        break;
      }

      batches.push({ anchor: best.anchor, regions: best.gain, observed: best.observed });
      for (const regionId of best.gain) remaining.delete(regionId);
      candidates.delete(best.anchor);
    }

    this.stats.plans += 1;
    this.stats.anchorsPlanned += batches.length;
    this.stats.regionsPlanned += regionIds.length;
    return batches;
  }

  /**
   * After a response, report regions that were planned but not actually covered so the
   * caller can re-query them directly rather than leaving stores at `unknown`.
   */
  verify(anchorId, plannedRegions, returnedStoreIds) {
    const covered = this.learn(anchorId, returnedStoreIds);
    const missed = plannedRegions.filter(regionId => !covered.has(regionId));
    if (missed.length) this.stats.misses += missed.length;
    return missed;
  }

  snapshot() {
    const fanout = this.stats.plans
      ? Math.round((this.stats.regionsPlanned / Math.max(1, this.stats.anchorsPlanned)) * 100) / 100
      : 0;
    return {
      anchorsKnown: this.observed.size,
      regionsPerRequest: fanout,
      plans: this.stats.plans,
      coverageMisses: this.stats.misses
    };
  }

  serialize() {
    return [...this.observed.entries()].map(([anchor, entry]) => ({
      anchor, at: entry.at, storeIds: [...entry.storeIds]
    }));
  }

  restore(rows) {
    if (!Array.isArray(rows)) return this;
    for (const row of rows) {
      if (!row?.anchor || !Array.isArray(row.storeIds)) continue;
      if (this.now() - Number(row.at || 0) > this.ttlMs) continue;
      this.learn(row.anchor, row.storeIds);
      const entry = this.observed.get(row.anchor);
      if (entry) entry.at = Number(row.at);
    }
    return this;
  }
}
