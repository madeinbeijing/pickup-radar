import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { catalog, getRegion, getVariant, getProduct, launchPhase, productOfSku } from './src/catalog.mjs';
import { InventoryService } from './src/inventory.mjs';
import { StateStore } from './src/state-store.mjs';
import { StockMonitor } from './src/monitor.mjs';
import { EventHub, Notifier } from './src/notifier.mjs';
import { CoveragePlanner } from './src/coverage.mjs';
import { logger } from './src/logger.mjs';
import { StatsRecorder, summarize, ledger, dayKey } from './src/stats.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolvePath(join(__dirname, 'public'));
const port = Number(process.env.PORT || 4173);
const dataDir = process.env.DATA_DIR || join(__dirname, '.data');

const RATE_LIMIT = Number(process.env.RATE_LIMIT || 180);
const RATE_WINDOW_MS = 60_000;
const SESSION_MAX_AGE = 365 * 24 * 60 * 60;
const MAX_WATCHES_PER_SESSION = Number(process.env.MAX_WATCHES_PER_SESSION || 24);

const log = logger.child({ mod: 'http' });

// ---- wiring ----------------------------------------------------------------

const stateStore = await new StateStore(join(dataDir, 'state.json')).init();
const planner = new CoveragePlanner({ catalog }).restore(stateStore.loadCoverage());
const stats = await new StatsRecorder({
  dir: join(dataDir, 'stats'),
  catalog,
  retentionDays: Number(process.env.STATS_RETENTION_DAYS || 30)
}).init();

const inventory = new InventoryService({
  catalog,
  planner,
  freshTtlMs: Number(process.env.FRESH_TTL_MS || 12_000),
  staleTtlMs: Number(process.env.STALE_TTL_MS || 10 * 60_000),
  timeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 7_000),
  retries: Number(process.env.FETCH_RETRIES || 2),
  maxConcurrency: Number(process.env.UPSTREAM_CONCURRENCY || 3),
  refillPerSec: Number(process.env.UPSTREAM_RPS || 1.5),
  recorder: stats
});

const hub = new EventHub();
const notifier = new Notifier({
  hub,
  store: stateStore,          // durable outbox: a restart resumes pending pushes
  barkUrl: process.env.BARK_URL || '',
  ntfyUrl: process.env.NTFY_URL || ''
}).restore();

const monitor = new StockMonitor({
  inventory,
  store: stateStore,
  catalog,
  notifier,
  intervalMs: Number(process.env.MONITOR_INTERVAL_MS || 30_000),
  alertCooldownMs: Number(process.env.ALERT_COOLDOWN_MS || 10 * 60_000),
  stats
});

if (process.env.DISABLE_MONITOR !== '1') monitor.start();

const heartbeat = setInterval(() => hub.heartbeat(), 25_000);
heartbeat.unref?.();

// Rate-limit buckets are unbounded by construction; sweep them so a long-lived process
// (or a spray of spoofed X-Forwarded-For values) cannot grow memory without limit.
const buckets = new Map();
const bucketSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, item] of buckets) if (item.start < cutoff) buckets.delete(ip);
}, 5 * 60_000);
bucketSweep.unref?.();

// ---- http helpers ----------------------------------------------------------

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(self)',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://www.apple.com.cn"
  };
}

function parseCookies(req) {
  const cookies = {};
  for (const chunk of String(req.headers.cookie || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index < 0) continue;
    cookies[chunk.slice(0, index).trim()] = decodeURIComponent(chunk.slice(index + 1).trim());
  }
  return cookies;
}

function ensureSession(req) {
  if (req.pickupSession) return req.pickupSession;
  const current = parseCookies(req).pickup_sid;
  const valid = /^[a-f0-9-]{36}$/i.test(current || '');
  req.pickupSession = valid ? current : randomUUID();
  req.pickupSessionNew = !valid;
  return req.pickupSession;
}

function sessionHeader(req) {
  if (!req.pickupSessionNew) return {};
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return { 'set-cookie': `pickup_sid=${ensureSession(req)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}` };
}

function json(req, res, status, body, extra = {}) {
  ensureSession(req);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...securityHeaders(),
    ...sessionHeader(req),
    ...extra
  });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'local';
}

function rateLimit(req, cost = 1) {
  const ip = clientIp(req);
  const now = Date.now();
  const item = buckets.get(ip) || { start: now, count: 0 };
  if (now - item.start > RATE_WINDOW_MS) { item.start = now; item.count = 0; }
  item.count += cost;
  buckets.set(ip, item);
  return item.count <= RATE_LIMIT;
}

async function readJson(req, maxBytes = 32_768) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('INVALID_JSON'); }
}

function publicWatch(watch) {
  const { sessionId, lastStates, alertedAt, ...safe } = watch;
  const states = lastStates ? Object.values(lastStates) : [];
  return {
    ...safe,
    monitoredStoreCount: states.length,
    availableStoreCount: states.filter(s => s === 'available').length,
    unknownStoreCount: states.filter(s => s === 'unknown').length
  };
}

/** Phase of one product (defaults to the catalog's default product). */
function phaseOf(productId) { return launchPhase(productId || catalog.defaultProduct); }

/** Phase of every product, for the catalog/health payloads. */
function allPhases() {
  return Object.fromEntries(Object.keys(catalog.products).map(id => [id, phaseOf(id)]));
}

function demoStores(regionInfo) {
  return regionInfo.stores.map((store, index) => ({
    id: store.id,
    name: store.name,
    city: regionInfo.label,
    state: regionInfo.label,
    distance: Number((2.3 + index * 2.4).toFixed(1)),
    status: index === 0 || index === 3 ? 'available' : index === 4 ? 'unknown' : 'unavailable',
    quote: index === 0 || index === 3 ? '今天可取货' : index === 4 ? '查询状态未确认' : '目前不可取货',
    title: index === 0 || index === 3 ? '可到店取货' : null,
    rawStatus: null,
    demo: true
  }));
}

/** Establish a baseline immediately so a new watch cannot fire a false first alert. */
async function primeWatch(watch) {
  if (phaseOf(watch.product) === 'preorder-not-open') return;
  try {
    const item = await inventory.queryOne({ sku: watch.sku, regionId: watch.region });
    const states = Object.fromEntries(item.stores.map(store => [store.id, store.status]));
    stateStore.updateWatchSnapshot(watch.id, states, item.fetchedAt);
  } catch (error) {
    log.warn('baseline priming failed; monitor will retry', { watch: watch.id, error: error.code || error.message });
  }
}

// ---- SSE -------------------------------------------------------------------

function handleStream(req, res) {
  if (!rateLimit(req)) return json(req, res, 429, { ok: false, error: 'RATE_LIMITED' }, { 'retry-after': '60' });
  const sessionId = ensureSession(req);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...securityHeaders(),
    ...sessionHeader(req)
  });
  res.socket?.setNoDelay?.(true);
  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, time: new Date().toISOString() })}\n\n`);

  // Replay anything missed while the browser was reconnecting.
  const lastEventId = Number(req.headers['last-event-id']);
  if (Number.isFinite(lastEventId)) {
    const missed = stateStore.eventsSince(sessionId, lastEventId);
    if (missed.length) {
      log.info('replaying missed events', { session: sessionId.slice(0, 8), count: missed.length });
      hub.replay(res, missed);
    }
  }

  const remove = hub.add(sessionId, res);
  req.on('close', remove);
  res.on('error', remove);
}

// ---- API -------------------------------------------------------------------

async function handleApi(req, res, url) {
  if (url.pathname === '/api/stream' && req.method === 'GET') return handleStream(req, res);
  if (!rateLimit(req)) return json(req, res, 429, { ok: false, error: 'RATE_LIMITED' }, { 'retry-after': '60' });
  const sessionId = ensureSession(req);

  if (url.pathname === '/api/catalog' && req.method === 'GET') {
    return json(req, res, 200, { ok: true, phases: allPhases(), defaultProduct: catalog.defaultProduct, catalog });
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    const inv = inventory.health();
    const degraded = inv.circuit.state !== 'closed' || Boolean(monitor.health().lastError);
    return json(req, res, degraded ? 503 : 200, {
      ok: !degraded,
      service: 'pickup-radar',
      version: catalog.meta.version,
      phases: allPhases(),
      uptimeSec: Math.round(process.uptime()),
      inventory: inv,
      monitor: monitor.health(),
      state: stateStore.statsSnapshot(),
      stream: hub.snapshot(),
      notifications: notifier.snapshot(),
      stats: stats.snapshot(),
      time: new Date().toISOString()
    });
  }

  if (url.pathname === '/api/metrics' && req.method === 'GET') {
    const inv = inventory.health();
    const mon = monitor.health();
    const lines = [
      `pickup_upstream_requests_total ${inv.counters.requests}`,
      `pickup_upstream_retries_total ${inv.counters.retries}`,
      `pickup_upstream_failures_total ${inv.counters.failures}`,
      `pickup_cache_hits_total ${inv.counters.cacheHits}`,
      `pickup_cache_stale_served_total ${inv.counters.staleServed}`,
      `pickup_cache_harvested_total ${inv.counters.harvested}`,
      `pickup_upstream_latency_ms ${inv.upstream.lastLatencyMs ?? 0}`,
      `pickup_circuit_open ${inv.circuit.state === 'closed' ? 0 : 1}`,
      `pickup_coverage_regions_per_request ${inv.coverage.regionsPerRequest}`,
      `pickup_monitor_ticks_total ${mon.counters.ticks}`,
      `pickup_monitor_alerts_total ${mon.counters.alerts}`,
      `pickup_monitor_suppressed_total ${mon.counters.suppressed}`,
      `pickup_monitor_interval_ms ${mon.intervalMs}`,
      `pickup_watches_active ${stateStore.statsSnapshot().activeWatches}`,
      `pickup_stream_connections ${hub.count()}`
    ];
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders() });
    return res.end(lines.join('\n') + '\n');
  }

  if ((url.pathname === '/api/stats' || url.pathname === '/api/stats/events') && req.method === 'GET') {
    const day = url.searchParams.get('day') || dayKey(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(req, res, 400, { ok: false, error: 'INVALID_DAY' });
    const events = await stats.readEvents(day);

    if (url.pathname === '/api/stats/events') {
      const type = url.searchParams.get('type');
      const region = url.searchParams.get('region');
      const product = url.searchParams.get('product');
      if (type && type !== 'up' && type !== 'down') return json(req, res, 400, { ok: false, error: 'INVALID_TYPE' });
      if (region && !getRegion(region)) return json(req, res, 400, { ok: false, error: 'INVALID_REGION' });
      if (product && !getProduct(product)) return json(req, res, 400, { ok: false, error: 'INVALID_PRODUCT' });
      const sku = url.searchParams.get('sku');
      if (sku && !productOfSku(sku)) return json(req, res, 400, { ok: false, error: 'INVALID_SKU' });
      const hourParam = url.searchParams.get('hour');
      const hour = hourParam == null || hourParam === '' ? null : Number(hourParam);
      if (hour != null && !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) return json(req, res, 400, { ok: false, error: 'INVALID_HOUR' });
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const result = ledger({
        day, events, limit,
        before: url.searchParams.get('before'),
        filters: { type, region, product, sku, hour, capacity: url.searchParams.get('capacity') || null }
      });
      return json(req, res, 200, { ok: true, day, ...result });
    }

    // Default the chart to the product with the most activity that day.
    const requested = url.searchParams.get('product');
    if (requested && !getProduct(requested)) return json(req, res, 400, { ok: false, error: 'INVALID_PRODUCT' });
    const tally = {};
    for (const e of events) if (e.product) tally[e.product] = (tally[e.product] || 0) + 1;
    const busiest = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
    const product = requested || busiest || catalog.defaultProduct;

    const { counters, firstObservedAt } = await stats.readCounters(day);
    const summary = summarize({ day, events, counters, firstObservedAt, product, catalog, now: Date.now() });
    return json(req, res, 200, {
      ok: true,
      ...summary,
      rankingTotal: summary.ranking.length,
      days: await stats.availableDays(),
      regionsSeen: [...new Set(events.filter(e => e.product === product).map(e => e.region).filter(Boolean))],
      productNames: Object.fromEntries(Object.values(catalog.products).map(p => [p.id, p.name])),
      configBySku: Object.fromEntries(Object.entries(getProduct(product).variants).map(([key, v]) => {
        const [capacity, color] = key.split(':');
        const info = getProduct(product).colors.find(c => c.id === color);
        return [v.sku, { name: `${capacity} ${info?.label || color}`, swatch: info?.swatch || null }];
      })),
      regions: Object.fromEntries(Object.entries(catalog.regions).map(([id, r]) => [id, r.label]))
    });
  }

  if (url.pathname === '/api/demo' && req.method === 'GET') {
    const regionInfo = getRegion(url.searchParams.get('region') || 'beijing');
    if (!regionInfo) return json(req, res, 400, { ok: false, error: 'INVALID_REGION' });
    return json(req, res, 200, {
      ok: true, demo: true, cache: 'DEMO', stale: false,
      region: url.searchParams.get('region') || 'beijing',
      fetchedAt: new Date().toISOString(),
      stores: demoStores(regionInfo)
    });
  }

  if (url.pathname === '/api/availability' && req.method === 'GET') {
    const productId = url.searchParams.get('product') || catalog.defaultProduct;
    const product = getProduct(productId);
    const capacity = url.searchParams.get('capacity') || product?.capacities[0];
    const color = url.searchParams.get('color') || product?.colors[0]?.id;
    const regionId = url.searchParams.get('region') || 'beijing';
    const variant = getVariant(productId, capacity, color);
    const regionInfo = getRegion(regionId);
    if (!product || !variant || !regionInfo) return json(req, res, 400, { ok: false, error: 'INVALID_SELECTION' });

    if (phaseOf(productId) === 'preorder-not-open') {
      return json(req, res, 200, {
        ok: true, gate: 'preorder-not-open',
        product: productId,
        preorderAt: product.preorderAt,
        releaseAt: product.releaseAt,
        stores: [], variant, region: regionId
      });
    }

    // A page query is a refresh that needed stock data; gated pre-launch refreshes above
    // never reach Apple or the cache, so they are not counted.
    stats.count('pageQueries');
    try {
      const item = await inventory.queryOne({ sku: variant.sku, regionId });
      if (item.cache === 'HIT') stats.count('cacheHits');
      return json(req, res, 200, {
        ok: true,
        ...item,
        product: productId,
        variant,
        regionInfo: { label: regionInfo.label, expectedStoreCount: regionInfo.stores.length }
      });
    } catch (error) {
      return json(req, res, 502, {
        ok: false,
        error: error?.code || error?.message || 'UPSTREAM_ERROR',
        status: 'unknown',
        reason: 'Apple 库存源查询失败；不能解释为“无货”。'
      });
    }
  }

  if (url.pathname === '/api/watches' && req.method === 'GET') {
    return json(req, res, 200, { ok: true, watches: stateStore.listWatches(sessionId).map(publicWatch) });
  }

  if (url.pathname === '/api/watches' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const productId = String(body.product || catalog.defaultProduct);
      const product = getProduct(productId);
      const capacity = String(body.capacity || '');
      const color = String(body.color || '');
      const regionId = String(body.region || '');
      const variant = getVariant(productId, capacity, color);
      const regionInfo = getRegion(regionId);
      const colorInfo = product?.colors.find(item => item.id === color);
      if (!product || !variant || !regionInfo || !colorInfo) {
        return json(req, res, 400, { ok: false, error: 'INVALID_SELECTION' });
      }

      const existing = stateStore.findWatch(sessionId, { sku: variant.sku, region: regionId });
      if (!existing && stateStore.listWatches(sessionId).length >= MAX_WATCHES_PER_SESSION) {
        return json(req, res, 429, { ok: false, error: 'WATCH_LIMIT_REACHED', limit: MAX_WATCHES_PER_SESSION });
      }

      // Arming before a product opens is legitimate and is the whole point of
      // "提前布控": the monitor skips it until the window opens, and its first reading
      // then counts as a real arrival rather than a silent baseline.
      const armedBeforeLaunch = phaseOf(productId) === 'preorder-not-open';

      const watch = stateStore.createWatch(sessionId, {
        // Only written when true: `clearArmedFlag` deletes the key after it is consumed,
        // so storing `false` would give one meaning two on-disk representations.
        ...(armedBeforeLaunch ? { armedBeforeLaunch: true } : {}),
        product: productId,
        productName: product.name,
        sku: variant.sku,
        capacity, color,
        colorLabel: colorInfo.label,
        region: regionId,
        regionLabel: regionInfo.label,
        appleUrl: `${product.buyBase}${variant.slug}`
      });
      if (!watch.lastStates) await primeWatch(watch);
      // A new watch must not wait out a long idle sleep before its first real round.
      if (!existing) monitor.kick('watch-created');
      return json(req, res, existing ? 200 : 201, { ok: true, watch: publicWatch(watch) });
    } catch (error) {
      const code = error?.message || 'WATCH_CREATE_FAILED';
      return json(req, res, code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: code });
    }
  }

  const watchMatch = url.pathname.match(/^\/api\/watches\/([a-f0-9-]{36})$/i);
  if (watchMatch && req.method === 'DELETE') {
    const removed = stateStore.deleteWatch(sessionId, watchMatch[1]);
    return json(req, res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : 'WATCH_NOT_FOUND' });
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    return json(req, res, 200, { ok: true, events: stateStore.listEvents(sessionId, limit) });
  }

  return json(req, res, 404, { ok: false, error: 'NOT_FOUND' });
}

// ---- static ----------------------------------------------------------------

const etagCache = new Map();

async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return json(req, res, 400, { ok: false, error: 'BAD_REQUEST' }); }
  if (pathname === '/') pathname = '/index.html';

  const filePath = resolvePath(join(publicDir, normalize(pathname)));
  // Containment check on the resolved path; a prefix test alone would allow `/publicX`.
  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
    return json(req, res, 403, { ok: false, error: 'FORBIDDEN' });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('ENOTFILE');

    const key = `${filePath}:${info.mtimeMs}:${info.size}`;
    let etag = etagCache.get(key);
    if (!etag) {
      etag = `W/"${createHash('sha1').update(key).digest('base64url').slice(0, 20)}"`;
      if (etagCache.size > 200) etagCache.clear();
      etagCache.set(key, etag);
    }

    const extension = extname(filePath);
    const immutable = !['.html', '.js', '.css', '.webmanifest'].includes(extension);
    const headers = {
      'content-type': mime[extension] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=86400' : 'no-cache',
      etag,
      'last-modified': new Date(info.mtimeMs).toUTCString(),
      ...securityHeaders()
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    res.writeHead(200, { ...headers, 'content-length': info.size });
    if (req.method === 'HEAD') return res.end();
    return res.end(await readFile(filePath));
  } catch {
    // SPA fallback belongs to navigations only. A missing asset must 404, not silently
    // return HTML with a 200 — that turns a typo into a confusing MIME error.
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (!wantsHtml || extname(filePath)) {
      return json(req, res, 404, { ok: false, error: 'NOT_FOUND' });
    }
    const html = await readFile(join(publicDir, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...securityHeaders() });
    return res.end(html);
  }
}

// ---- server ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.on('finish', () => {
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/stream') {
      log.debug('request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  });

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    log.error('unhandled request error', { path: url.pathname, error: error?.message });
    if (res.headersSent) return res.end();
    return json(req, res, 500, { ok: false, error: 'INTERNAL_ERROR' });
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 30_000;

server.listen(port, '0.0.0.0', () => {
  logger.info(`Pickup Radar v${catalog.meta.version} listening`, {
    url: `http://localhost:${port}`,
    products: Object.keys(catalog.products).length,
    phases: allPhases(),
    watches: stateStore.statsSnapshot().activeWatches,
    monitor: process.env.DISABLE_MONITOR === '1' ? 'disabled' : 'enabled'
  });
});

// ---- graceful shutdown -----------------------------------------------------

let shuttingDown = false;
/**
 * Graceful shutdown.
 *
 * `code` is the exit status for a clean path. A fatal fault (uncaught exception,
 * unhandled rejection) or a failed final state flush must exit NON-ZERO — a supervisor
 * that sees exit 0 may treat a crash as an intentional stop and never restart, which for
 * a stock monitor means silently missing everything.
 */
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal, intendedExitCode: code });

  clearInterval(heartbeat);
  clearInterval(bucketSweep);
  server.close();
  hub.closeAll();

  const deadline = setTimeout(() => {
    logger.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  deadline.unref?.();

  try {
    await monitor.stop();
    stateStore.saveCoverage(planner.serialize());
    // Close both even if one fails, then surface the first failure.
    const results = await Promise.allSettled([stateStore.close(), stats.close()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    logger.info('state flushed, bye');
    process.exit(code);
  } catch (error) {
    // A failed final flush is itself a fatal condition: state was lost.
    logger.error('shutdown error', { error: error?.message, code: error?.code });
    process.exit(code || 1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('unhandledRejection', reason => {
  logger.error('unhandled rejection', { reason: String(reason?.message || reason) });
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', error => {
  logger.error('uncaught exception', { error: error?.message, stack: error?.stack?.split('\n')[1]?.trim() });
  shutdown('uncaughtException', 1);
});
