import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalog, getRegion, getVariant, getProduct, productOfSku, launchPhase } from './src/catalog.mjs';
import { InventoryService, normalizeApplePayload, reconcileRegionStores, validateContract } from './src/inventory.mjs';
import { CoveragePlanner } from './src/coverage.mjs';
import { CircuitBreaker, TokenBucket, Semaphore, backoffDelay, mapPool } from './src/resilience.mjs';
import { fetchJson, parseRetryAfter, classify } from './src/upstream.mjs';
import { StateStore } from './src/state-store.mjs';
import { StockMonitor } from './src/monitor.mjs';
import { EventHub, Notifier } from './src/notifier.mjs';
import { RequestGuard, sameSelection } from './public/request-guard.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${error.message}`); }
}
const group = name => console.log(`\n\x1b[1m${name}\x1b[0m`);

// A fake clock lets every time-dependent policy be asserted deterministically.
// Default to a post-release instant: the monitor deliberately idles before pre-orders open.
function fakeClock(start = Date.parse('2026-09-20T10:00:00+08:00')) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; }, set: v => { t = v; } };
}

const SAMPLE = {
  body: {
    stores: [
      {
        storeNumber: 'R320', storeName: '三里屯', city: '北京', storedistance: '2.4',
        partsAvailability: {
          'MJY74CH/A': { pickupDisplay: 'available', pickupSearchQuote: '今天可取货', messageTypes: { regular: { storePickupProductTitle: '可到店取货' } } },
          'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }
        }
      },
      { storeNumber: 'R448', storeName: '王府井', city: '北京', storedistance: '5.1',
        partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      { storeNumber: 'R479', storeName: '华贸购物中心', city: '北京', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      { storeNumber: 'R388', storeName: '西单大悦城', city: '北京', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      { storeNumber: 'R645', storeName: '朝阳大悦城', city: '北京', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      { storeNumber: 'R792', storeName: '北京荟聚', city: '北京', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      // Nearby cluster spill-over: a Beijing anchor also returns Tianjin.
      { storeNumber: 'R579', storeName: '天津恒隆广场', city: '天津', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'available', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      { storeNumber: 'R637', storeName: '天津大悦城', city: '天津', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } },
      { storeNumber: 'R638', storeName: '天津万象城', city: '天津', partsAvailability: { 'MJY74CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } }, 'MJY64CH/A': { pickupDisplay: 'unavailable', messageTypes: { regular: {} } } } }
    ]
  }
};

const okResponse = data => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });

// ---------------------------------------------------------------- catalog ---
group('目录数据约束');
await test('25 个城市 / 49 家门店，ID 唯一', () => {
  assert.equal(Object.keys(catalog.regions).length, 25);
  const stores = Object.values(catalog.regions).flatMap(r => r.stores);
  assert.equal(stores.length, 49);
  assert.equal(new Set(stores.map(s => s.id)).size, 49);
});
await test('iPhone 18 Pro Max: 4 容量 × 4 色 = 16 SKU', () => {
  const p = getProduct('iphone-18-pro-max');
  assert.equal(p.capacities.length * p.colors.length, 16);
  assert.equal(Object.keys(p.variants).length, 16);
  assert.equal(getVariant('iphone-18-pro-max', '256GB', 'silver').sku, 'MJY74CH/A');
});
await test('iPhone Duo: 4 容量 × 2 色 = 8 SKU（真实零件号）', () => {
  const p = getProduct('iphone-duo');
  assert.equal(p.capacities.length * p.colors.length, 8);
  assert.equal(Object.keys(p.variants).length, 8);
  assert.deepEqual(p.colors.map(c => c.id), ['nightsky', 'starwhite']);
  assert.equal(getVariant('iphone-duo', '256GB', 'starwhite').sku, 'MK2M4CH/A');
  assert.equal(getVariant('iphone-duo', '2TB', 'nightsky').sku, 'MK2W4CH/A');
  assert.equal(getVariant('iphone-duo', '256GB', 'nightsky').price, 15999);
});
await test('所有机型的 SKU 全局唯一且形如 CH/A', () => {
  const all = Object.values(catalog.products).flatMap(p => Object.values(p.variants).map(v => v.sku));
  assert.equal(new Set(all).size, all.length, 'SKU 不得在机型间重复');
  for (const sku of all) assert.match(sku, /^M[A-Z0-9]{4,6}CH\/A$/, `${sku} 不是合法的中国大陆零件号`);
});
await test('每个变体的 slug 与 SKU 一致，买链可拼装', () => {
  for (const p of Object.values(catalog.products)) {
    for (const v of Object.values(p.variants)) {
      assert.equal(v.slug, v.sku.toLowerCase(), `${v.sku} 的 slug 不匹配`);
      assert.ok(p.buyBase.endsWith('/'), `${p.id} 的 buyBase 需以 / 结尾`);
    }
  }
});
await test('可由 SKU 反查机型', () => {
  assert.equal(productOfSku('MK2W4CH/A').id, 'iphone-duo');
  assert.equal(productOfSku('MJY74CH/A').id, 'iphone-18-pro-max');
  assert.equal(productOfSku('NOPE'), null);
});
await test('各机型发售阶段独立判定', () => {
  const beforeBoth = Date.parse('2026-09-01T00:00:00+08:00');
  const between = Date.parse('2026-09-20T00:00:00+08:00');
  assert.equal(launchPhase('iphone-18-pro-max', beforeBoth), 'preorder-not-open');
  assert.equal(launchPhase('iphone-18-pro-max', between), 'released');
  // Duo 预售要到 10-16，此时仍未开放——不得被 18 Pro 的时间线带跑
  assert.equal(launchPhase('iphone-duo', between), 'preorder-not-open');
  assert.equal(launchPhase('iphone-duo', Date.parse('2026-10-20T00:00:00+08:00')), 'preorder-open');
  assert.equal(launchPhase('iphone-duo', Date.parse('2026-10-25T00:00:00+08:00')), 'released');
});
await test('每个城市的 seed store 属于该城市且有坐标', () => {
  for (const [id, region] of Object.entries(catalog.regions)) {
    assert.ok(region.stores.some(s => s.id === region.seedStore), `${id} seed 不在门店列表内`);
    assert.ok(Number.isFinite(region.lat) && Number.isFinite(region.lon), `${id} 缺坐标`);
  }
});

// ------------------------------------------------------------- schema ------
group('Apple 响应解析契约');
await test('available / unavailable 正确归一化', () => {
  assert.equal(normalizeApplePayload(SAMPLE, 'MJY74CH/A')[0].status, 'available');
  assert.equal(normalizeApplePayload(SAMPLE, 'MJY64CH/A')[0].status, 'unavailable');
});
await test('SKU 缺失抛错，绝不降级为无货', () => {
  assert.throws(() => normalizeApplePayload(SAMPLE, 'MISSING'), /APPLE_PART_MISSING/);
});
await test('结构变化抛 APPLE_SCHEMA_CHANGED', () => {
  assert.throws(() => normalizeApplePayload({ body: {} }, 'MJY74CH/A'), /APPLE_SCHEMA_CHANGED/);
});
await test('未返回的门店标记为 unknown 而非 unavailable', () => {
  const partial = { body: { stores: [SAMPLE.body.stores[0]] } };
  const rows = reconcileRegionStores(normalizeApplePayload(partial, 'MJY74CH/A'), getRegion('beijing'));
  assert.equal(rows.length, 6);
  const missing = rows.filter(r => r.missingFromResponse);
  assert.equal(missing.length, 5);
  assert.ok(missing.every(r => r.status === 'unknown'));
});

// ------------------------------------------------------- searchNearby -----
group('上游请求构造（核心修复）');
await test('请求必须带 searchNearby=true，否则整城只能拿到 1 家店', () => {
  const inv = new InventoryService({ catalog });
  const url = inv.buildUrl('R320', ['MJY74CH/A']);
  assert.match(url, /searchNearby=true/, '缺少 searchNearby 会让全城门店恒为 unknown');
  assert.match(url, /store=R320/);
  assert.match(url, /parts\.0=MJY74CH%2FA/);
});
await test('多 SKU 批量映射到 parts.N', () => {
  const inv = new InventoryService({ catalog });
  const url = inv.buildUrl('R401', ['A/A', 'B/A', 'C/A']);
  assert.match(url, /parts\.0=A%2FA/);
  assert.match(url, /parts\.1=B%2FA/);
  assert.match(url, /parts\.2=C%2FA/);
});

// -------------------------------------------------- 上游契约校验（回归）----
group('上游契约校验');
const PART = { pickupDisplay: 'unavailable', messageTypes: { regular: {} } };
const wrap = stores => ({ body: { stores } });

await test('结构变化 / 空门店 / SKU 全缺失 判为硬失败', () => {
  assert.equal(validateContract({ body: {} }, ['A/A']).error, 'APPLE_SCHEMA_CHANGED');
  assert.equal(validateContract(wrap([]), ['A/A']).error, 'APPLE_EMPTY_STORES');
  assert.equal(validateContract(wrap([{ storeNumber: 'R320', partsAvailability: {} }]), ['A/A']).error, 'APPLE_PART_MISSING');
  assert.equal(validateContract(wrap([{ partsAvailability: { 'A/A': PART } }]), ['A/A']).error, 'APPLE_SCHEMA_CHANGED');
});
await test('部分 SKU 缺失只记警告，不判失败（可能是真的未上架）', () => {
  const r = validateContract(wrap([{ storeNumber: 'R320', partsAvailability: { 'A/A': PART } }]), ['A/A', 'B/A']);
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.deepEqual(r.missingSkus, ['B/A']);
});
await test('畸形 200 必须触发熔断，不得记为成功（v2.2 真实缺陷）', async () => {
  const inv = new InventoryService({
    catalog, retries: 0, failureThreshold: 2,
    fetchImpl: async () => okResponse({ body: { stores: [{ storeNumber: 'R320', partsAvailability: {} }] } })
  });
  await inv.queryPlan(new Map([['beijing', ['MJY74CH/A']]]));
  const h1 = inv.health();
  assert.equal(h1.upstream.lastSuccessAt, null, '结构不合约时不得写入 lastSuccessAt');
  assert.ok(h1.upstream.lastError, '必须记录错误');
  assert.equal(h1.counters.contractFailures > 0, true, '必须计入契约失败');

  await inv.queryPlan(new Map([['shanghai', ['MJY74CH/A']]]));
  assert.notEqual(inv.breaker.state, 'closed', '连续契约失败必须打开熔断，而不是一直显示健康');
});
await test('健康检查如实暴露契约状态', async () => {
  const inv = new InventoryService({
    catalog, retries: 0,
    fetchImpl: async () => okResponse({ body: {} })
  });
  await inv.queryPlan(new Map([['beijing', ['MJY74CH/A']]]));
  const h = inv.health();
  assert.equal(h.upstream.lastError, 'APPLE_SCHEMA_CHANGED');
  assert.equal(h.counters.contractFailures, 1);
});
await test('契约失败仍只产生 unknown，绝不产生"无货"', async () => {
  const inv = new InventoryService({
    catalog, retries: 0,
    fetchImpl: async () => okResponse({ body: {} })
  });
  const plan = await inv.queryPlan(new Map([['beijing', ['MJY74CH/A']]]));
  const item = plan.get('beijing')['MJY74CH/A'];
  assert.equal(item.ok, false);
  assert.equal(item.status, 'unknown');
});

// ---------------------------------------------------------- coverage ------
group('覆盖规划器（集合覆盖）');
await test('无观测时退化为每城一个锚点', () => {
  const p = new CoveragePlanner({ catalog });
  assert.equal(p.plan(['beijing', 'tianjin']).length, 2);
});
await test('学到簇之后合并为单次请求', () => {
  const p = new CoveragePlanner({ catalog });
  p.learn('R320', ['R320', 'R448', 'R479', 'R388', 'R645', 'R792', 'R579', 'R637', 'R638']);
  const plan = p.plan(['beijing', 'tianjin']);
  assert.equal(plan.length, 1, '北京+天津应合并为 1 次请求');
  assert.equal(plan[0].anchor, 'R320');
  assert.deepEqual(new Set(plan[0].regions), new Set(['beijing', 'tianjin']));
});
await test('部分覆盖不算覆盖（严格安全，宁可多发一次请求）', () => {
  const p = new CoveragePlanner({ catalog });
  // 杭州有 2 家店，只返回 1 家
  p.learn('R401', ['R401', 'R532']);
  assert.ok(!p.coverageOf('R401').has('hangzhou'), '缺店时不得判定为已覆盖');
});
await test('观测条目过期后回退到先验', () => {
  const clock = fakeClock();
  const p = new CoveragePlanner({ catalog, ttlMs: 1_000, now: clock.now });
  p.learn('R320', ['R320', 'R448', 'R479', 'R388', 'R645', 'R792', 'R579', 'R637', 'R638']);
  assert.equal(p.plan(['beijing', 'tianjin']).length, 1);
  clock.advance(2_000);
  assert.equal(p.plan(['beijing', 'tianjin']).length, 2, '过期后必须重新按城市发请求');
});
await test('序列化 / 还原覆盖图', () => {
  const p = new CoveragePlanner({ catalog });
  p.learn('R320', ['R320', 'R448', 'R479', 'R388', 'R645', 'R792']);
  const revived = new CoveragePlanner({ catalog }).restore(p.serialize());
  assert.ok(revived.coverageOf('R320').has('beijing'));
});

// ---------------------------------------------------------- inventory -----
group('库存服务');
await test('一次请求同时写入北京和天津缓存（跨城收割）', async () => {
  let calls = 0;
  const inv = new InventoryService({ catalog, fetchImpl: async () => { calls += 1; return okResponse(SAMPLE); } });
  const result = await inv.queryPlan(new Map([['beijing', ['MJY74CH/A']], ['tianjin', ['MJY74CH/A']]]));
  assert.equal(calls, 2, '首轮无先验，两城各一次');
  assert.equal(result.get('beijing')['MJY74CH/A'].stores.length, 6);
  assert.equal(result.get('tianjin')['MJY74CH/A'].stores.length, 3);

  // 第二轮：规划器已学到 R320 覆盖两城
  calls = 0;
  inv.cache.clear();
  await inv.queryPlan(new Map([['beijing', ['MJY74CH/A']], ['tianjin', ['MJY74CH/A']]]));
  assert.equal(calls, 1, '学习后应合并为单次上游请求');
});
await test('fresh 缓存命中不再打上游', async () => {
  let calls = 0;
  const inv = new InventoryService({ catalog, freshTtlMs: 60_000, fetchImpl: async () => { calls += 1; return okResponse(SAMPLE); } });
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  assert.equal(calls, 1);
});
await test('上游失败时回落 stale 并标注降级原因', async () => {
  const clock = fakeClock();
  let fail = false;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 1_000, staleTtlMs: 600_000, retries: 0,
    fetchImpl: async () => { if (fail) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); return okResponse(SAMPLE); }
  });
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  clock.advance(5_000);
  fail = true;
  const again = await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  assert.equal(again.stale, true);
  assert.ok(again.degradedReason, '降级必须带原因');
});
await test('无可信缓存时返回 unknown，绝不返回“无货”', async () => {
  const inv = new InventoryService({ catalog, retries: 0, fetchImpl: async () => { throw new Error('dead'); } });
  const plan = await inv.queryPlan(new Map([['beijing', ['MJY74CH/A']]]));
  const item = plan.get('beijing')['MJY74CH/A'];
  assert.equal(item.ok, false);
  assert.equal(item.status, 'unknown');
});
await test('并发相同请求被合并', async () => {
  let calls = 0;
  const inv = new InventoryService({
    catalog,
    fetchImpl: async () => { calls += 1; await new Promise(r => setTimeout(r, 20)); return okResponse(SAMPLE); }
  });
  await Promise.all([
    inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' }),
    inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' })
  ]);
  assert.equal(calls, 1);
});
await test('过期缓存被 sweep 回收', () => {
  const clock = fakeClock();
  const inv = new InventoryService({ catalog, staleTtlMs: 1_000, now: clock.now });
  inv.cache.set('x|beijing', { at: clock.now(), value: {} });
  clock.advance(5_000);
  assert.equal(inv.sweep(), 1);
  assert.equal(inv.cache.size, 0);
});

// --------------------------------------------------------- resilience -----
group('弹性原语');
await test('熔断器 closed → open → half-open → closed', () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000, probeSuccesses: 2, now: clock.now });
  cb.onFailure(new Error('a'));
  assert.equal(cb.state, 'closed');
  cb.onFailure(new Error('b'));
  assert.equal(cb.state, 'open');
  assert.equal(cb.tryAcquire(), false);
  clock.advance(1_100);
  assert.equal(cb.tryAcquire(), true, '冷却后应放行探针');
  assert.equal(cb.state, 'half-open');
  assert.equal(cb.tryAcquire(), false, 'half-open 最多放行 maxProbes 个探针');
  cb.onSuccess();
  cb.tryAcquire(); cb.onSuccess();
  assert.equal(cb.state, 'closed');
});
await test('half-open 失败重新打开且退避加倍', () => {
  const clock = fakeClock();
  const cb = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: clock.now });
  cb.onFailure(new Error('x'));
  const first = cb.openMs;
  clock.advance(1_100);
  cb.tryAcquire();
  cb.onFailure(new Error('y'));
  assert.equal(cb.state, 'open');
  assert.ok(cb.openMs > first, '连续熔断应指数退避');
});
await test('令牌桶限制突发并按速率补充', () => {
  const clock = fakeClock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: clock.now });
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, '突发额度用尽');
  clock.advance(1_000);
  assert.equal(b.take(), true, '1 秒后补充 1 个令牌');
});
await test('信号量限制并发数', async () => {
  const s = new Semaphore(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => s.run(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active -= 1;
  })));
  assert.equal(peak, 2);
});
await test('全抖动退避落在 [0, 上限) 区间', () => {
  assert.equal(backoffDelay(0, { baseMs: 100, random: () => 0 }), 0);
  assert.equal(backoffDelay(3, { baseMs: 100, maxMs: 10_000, random: () => 0.999 }), 799);
});
await test('mapPool 保序且不因单个失败中断', async () => {
  const out = await mapPool([1, 2, 3], 2, async n => { if (n === 2) throw new Error('nope'); return n * 10; });
  assert.equal(out[0].value, 10);
  assert.equal(out[1].ok, false);
  assert.equal(out[2].value, 30);
});

// ----------------------------------------------------------- upstream -----
group('HTTP 客户端');
await test('超时与网络错误判定为可重试', () => {
  assert.equal(classify(Object.assign(new Error('t'), { name: 'AbortError' })).retryable, true);
  assert.equal(classify(Object.assign(new Error('r'), { code: 'ECONNRESET' })).retryable, true);
  assert.equal(classify(new Error('weird')).retryable, false);
});
await test('5xx 重试，4xx 立即失败', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('https://x', {
    retries: 2, random: () => 0,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 503, headers: { get: () => null } }; }
  }));
  assert.equal(calls, 3, '503 应重试到预算耗尽');

  calls = 0;
  await assert.rejects(fetchJson('https://x', {
    retries: 2, random: () => 0,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 400, headers: { get: () => null } }; }
  }));
  assert.equal(calls, 1, '400 不可重试');
});
await test('Apple 非标准限流码 541 必须可重试（实测遇到）', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('https://x', {
    retries: 2, random: () => 0,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 541, headers: { get: () => null } }; }
  }));
  assert.equal(calls, 3, '任意 5xx 都应重试，不能只枚举 500/502/503/504');
});
await test('429 可重试且遵守 Retry-After', async () => {
  let calls = 0;
  await assert.rejects(fetchJson('https://x', {
    retries: 1, random: () => 0,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 429, headers: { get: h => h === 'retry-after' ? '0' : null } }; }
  }));
  assert.equal(calls, 2);
});
await test('重试后成功返回结果', async () => {
  let calls = 0;
  const { data, attempts } = await fetchJson('https://x', {
    retries: 2, random: () => 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return okResponse(SAMPLE);
    }
  });
  assert.equal(attempts, 2);
  assert.ok(data.body.stores.length);
});
await test('Retry-After 解析（秒与 HTTP 日期）', () => {
  assert.equal(parseRetryAfter('5'), 5_000);
  assert.equal(parseRetryAfter('99999'), 120_000, '需要封顶');
  assert.equal(parseRetryAfter(null), null);
});

// -------------------------------------------------------------- state -----
group('持久化');
const dir = await mkdtemp(join(tmpdir(), 'pickup-test-'));
await test('关注创建 / 查询 / 删除与会话隔离', async () => {
  const store = await new StateStore(join(dir, 'a.json'), { flushDebounceMs: 5 }).init();
  const w = store.createWatch('s1', { sku: 'X', region: 'beijing' });
  store.createWatch('s2', { sku: 'X', region: 'beijing' });
  assert.equal(store.listWatches('s1').length, 1);
  assert.equal(store.findWatch('s1', { sku: 'X', region: 'beijing' }).id, w.id);
  assert.equal(store.deleteWatch('s2', w.id), false, '不得跨会话删除他人关注');
  assert.equal(store.deleteWatch('s1', w.id), true);
  assert.equal(store.listWatches('s1').length, 0);
  await store.close();
});
await test('重启后关注与事件仍在（含索引重建）', async () => {
  const path = join(dir, 'b.json');
  const s1 = await new StateStore(path, { flushDebounceMs: 5 }).init();
  s1.createWatch('sess', { sku: 'X', region: 'beijing' });
  s1.addEvent({ sessionId: 'sess', type: 'stock_available', storeId: 'R320' });
  await s1.close();

  const s2 = await new StateStore(path).init();
  assert.equal(s2.listWatches('sess').length, 1);
  assert.equal(s2.listEvents('sess').length, 1);
  await s2.close();
});
await test('写入失败不会毒化后续写入（v1.1 真实缺陷）', async () => {
  const store = await new StateStore(join(dir, 'c.json'), { flushDebounceMs: 5 }).init();
  const realPath = store.filePath;
  store.filePath = '/nonexistent-dir-xyz/state.json';   // 强制写失败
  store.createWatch('s', { sku: 'X', region: 'beijing' });
  await store.flushNow();
  assert.equal(store.stats.writeErrors, 1);
  store.filePath = realPath;                            // 恢复后必须能继续写
  store.createWatch('s', { sku: 'Y', region: 'shanghai' });
  await store.flushNow();
  assert.equal(store.stats.writes >= 1, true, '一次写失败后必须仍能成功写入');
  const onDisk = JSON.parse(await readFile(realPath, 'utf8'));
  assert.equal(onDisk.watches.length, 2);
  await store.close();
});
await test('close() 在最终落盘失败时必须抛出（不能静默"成功退出"）', async () => {
  const store = await new StateStore(join(dir, 'cl.json'), { flushDebounceMs: 5 }).init();
  store.createWatch('s', { sku: 'X', region: 'beijing' });
  store.filePath = '/nonexistent-dir-xyz/state.json';
  await assert.rejects(() => store.close(), /STATE_FLUSH_FAILED/,
    '落盘失败若被吞掉，调用方就无法用非零码退出，守护进程会把崩溃当成正常停止');
});
await test('flushNow 返回结果而非抛出，供后台去抖路径安全调用', async () => {
  const store = await new StateStore(join(dir, 'fl.json'), { flushDebounceMs: 5 }).init();
  assert.equal((await store.flushNow()).ok, true);
  store.filePath = '/nonexistent-dir-xyz/state.json';
  store.createWatch('s', { sku: 'Y', region: 'beijing' });
  const bad = await store.flushNow();
  assert.equal(bad.ok, false);
  assert.ok(store.stats.lastWriteError);
});
await test('迁移后立即落盘，磁盘版本号不得滞后于运行版本', async () => {
  const path = join(dir, 'mig.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 2, seq: 0, coverage: [], events: [],
    watches: [{ id: 'w1', sessionId: 's', enabled: true, sku: 'MJY74CH/A', region: 'beijing' }]
  }), 'utf8');
  const store = await new StateStore(path, { flushDebounceMs: 5 }).init();
  await store.flushNow();
  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(onDisk.schemaVersion, 4);
  assert.equal(onDisk.watches[0].product, 'iphone-18-pro-max', '迁移结果必须落盘');
  await store.close();
});
await test('v3 的 upgrade 字段在迁移时被清除', async () => {
  const path = join(dir, 'mig2.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 3, seq: 0, coverage: [], events: [],
    watches: [{ id: 'w1', sessionId: 's', enabled: true, sku: 'MK2W4CH/A', region: 'shanghai',
               upgrade: { enabled: true, joinedAt: '2026-01-01' } }]
  }), 'utf8');
  const store = await new StateStore(path, { flushDebounceMs: 5 }).init();
  const watch = store.allWatches()[0];
  assert.equal('upgrade' in watch, false, '功能已移除，死字段不得残留');
  assert.equal(watch.product, 'iphone-duo', '应由 SKU 反查出机型');
  await store.close();
});
await test('损坏的状态文件被隔离而非静默丢弃', async () => {
  const path = join(dir, 'd.json');
  await writeFile(path, '{ this is not json', 'utf8');
  const store = await new StateStore(path).init();
  assert.equal(store.allWatches().length, 0);
  await store.close();
});
await test('事件序号单调，支持 Last-Event-ID 重放', async () => {
  const store = await new StateStore(join(dir, 'e.json'), { flushDebounceMs: 5 }).init();
  const a = store.addEvent({ sessionId: 's', type: 't' });
  const b = store.addEvent({ sessionId: 's', type: 't' });
  assert.equal(b.seq, a.seq + 1);
  assert.equal(store.eventsSince('s', a.seq).length, 1);
  assert.equal(store.eventsSince('s', 0).length, 2);
  await store.close();
});
await test('写入被去抖合并，而非每次变更都落盘', async () => {
  const store = await new StateStore(join(dir, 'f.json'), { flushDebounceMs: 50 }).init();
  for (let i = 0; i < 10; i += 1) store.createWatch('s', { sku: `S${i}`, region: 'beijing' });
  assert.ok(store.stats.coalesced > 0, '连续变更应被合并');
  await store.close();
  assert.ok(store.stats.writes <= 3, `10 次变更不应触发 ${store.stats.writes} 次落盘`);
});

// ------------------------------------------------------------ monitor -----
group('监控语义');
function monitorFixture({ clock, responses }) {
  let index = 0;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 1, retries: 0,
    fetchImpl: async () => okResponse(responses[Math.min(index++, responses.length - 1)])
  });
  return inv;
}
const NONE = structuredClone(SAMPLE);
for (const s of NONE.body.stores) s.partsAvailability['MJY74CH/A'].pickupDisplay = 'unavailable';

await test('首次成功查询只建立基线，不产生到货事件', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm1.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const hub = new EventHub();
  const notifier = new Notifier({ hub });
  const inv = monitorFixture({ clock, responses: [SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier, now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick();
  assert.equal(store.listEvents('s').length, 0, '首次查询不得报警');
  assert.ok(store.allWatches()[0].lastStates, '必须建立基线');
  await store.close();
});
await test('unavailable → available 触发一次，且不重复触发', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm2.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });

  await mon.tick();                       // 基线：全部 unavailable
  assert.equal(store.listEvents('s').length, 0);
  clock.advance(60_000);
  await mon.tick();                       // R320 变为 available
  assert.equal(store.listEvents('s').length, 1);
  clock.advance(60_000);
  await mon.tick();                       // 仍 available，不应重复报警
  assert.equal(store.listEvents('s').length, 1, 'available → available 不得重复报警');
  await store.close();
});
await test('抖动被冷却窗口抑制', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm3.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE, NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 10 * 60_000, now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });

  await mon.tick();  clock.advance(30_000);
  await mon.tick();  clock.advance(30_000);   // 报警 1
  await mon.tick();  clock.advance(30_000);   // 掉回 unavailable
  await mon.tick();                            // 再次 available，但在冷却窗口内
  assert.equal(store.listEvents('s').length, 1, '冷却窗口内的反复抖动只应报警一次');
  assert.ok(mon.counters.suppressed > 0);
  await store.close();
});
await test('冷却过期后允许再次报警', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm4.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE, NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 60_000, now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick();  clock.advance(30_000);
  await mon.tick();  clock.advance(30_000);
  await mon.tick();  clock.advance(120_000);   // 超过冷却
  await mon.tick();
  assert.equal(store.listEvents('s').length, 2);
  await store.close();
});
await test('stale 读数不得制造到货事件', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm5.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const watch = store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing' });
  store.updateWatchSnapshot(watch.id, { R320: 'unavailable' }, new Date().toISOString());
  const mon = new StockMonitor({ inventory: { breaker: { state: 'closed' } }, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  mon.evaluate(store.getWatch(watch.id), {
    ok: true, stale: true, staleAgeMs: 300_000, fetchedAt: new Date().toISOString(),
    stores: [{ id: 'R320', name: '三里屯', status: 'available' }]
  });
  assert.equal(store.listEvents('s').length, 0, '过期缓存不能当作实时到货');
  await store.close();
});
await test('unknown → available 视为真实到货', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm6.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const watch = store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing' });
  store.updateWatchSnapshot(watch.id, { R320: 'unknown' }, new Date().toISOString());
  const mon = new StockMonitor({ inventory: { breaker: { state: 'closed' } }, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  mon.evaluate(store.getWatch(watch.id), {
    ok: true, stale: false, fetchedAt: new Date().toISOString(),
    stores: [{ id: 'R320', name: '三里屯', status: 'available' }]
  });
  assert.equal(store.listEvents('s').length, 1);
  await store.close();
});

await test('未开售机型的关注不消耗上游请求', async () => {
  const clock = fakeClock(Date.parse('2026-10-01T00:00:00+08:00'));  // Duo 预售未开
  const store = await new StateStore(join(dir, 'm7.json'), { flushDebounceMs: 5, now: clock.now }).init();
  let calls = 0;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 1, retries: 0,
    fetchImpl: async () => { calls += 1; return okResponse(SAMPLE); }
  });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { product: 'iphone-duo', sku: 'MK2M4CH/A', region: 'beijing' });
  await mon.tick();
  assert.equal(calls, 0, 'Duo 未开售，不该发起任何上游请求');
  await store.close();
});
await test('同一轮里已开售机型照常查询，未开售机型被跳过', async () => {
  const clock = fakeClock(Date.parse('2026-10-01T00:00:00+08:00'));
  const store = await new StateStore(join(dir, 'm8.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const anchors = [];
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 1, retries: 0,
    fetchImpl: async url => { anchors.push(new URL(url).searchParams.get('store')); return okResponse(SAMPLE); }
  });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { product: 'iphone-duo', sku: 'MK2M4CH/A', region: 'beijing' });
  store.createWatch('s', { product: 'iphone-18-pro-max', sku: 'MJY74CH/A', region: 'beijing' });
  await mon.tick();
  assert.equal(anchors.length, 1, '只应为已开售的 18 Pro Max 发一次请求');
  assert.ok(store.allWatches().find(w => w.product === 'iphone-18-pro-max').lastStates, '已开售机型应建立基线');
  assert.equal(store.allWatches().find(w => w.product === 'iphone-duo').lastStates, null, '未开售机型不应有基线');
  await store.close();
});
await test('旧版 watch 缺少 product 字段时按 SKU 回填（v2→v3 迁移）', async () => {
  const path = join(dir, 'm9.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 2, seq: 0, coverage: [], events: [],
    watches: [{ id: 'legacy-1', sessionId: 's', enabled: true, sku: 'MJY74CH/A', region: 'beijing' },
              { id: 'legacy-2', sessionId: 's', enabled: true, sku: 'MK2W4CH/A', region: 'shanghai' }]
  }), 'utf8');
  const store = await new StateStore(path).init();
  const rows = store.allWatches();
  assert.equal(rows.find(w => w.id === 'legacy-1').product, 'iphone-18-pro-max');
  assert.equal(rows.find(w => w.id === 'legacy-2').product, 'iphone-duo', '应由 SKU 反查出 Duo');
  await store.close();
});

await test('提前布控：首轮查到有货必须提醒（否则提前布控毫无意义）', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'p1.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', {
    armedBeforeLaunch: true,
    product: 'iphone-18-pro-max', sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver'
  });
  await mon.tick();
  assert.equal(store.listEvents('s').length, 1, '提前布控的关注，首次见到有货即为真实到货');
  assert.equal(store.allWatches()[0].armedBeforeLaunch, undefined, '标记应一次性消费');
});
await test('非提前布控的关注，首轮仍只建基线', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'p2.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { product: 'iphone-18-pro-max', sku: 'MJY74CH/A', region: 'beijing' });
  await mon.tick();
  assert.equal(store.listEvents('s').length, 0);
  assert.ok(store.allWatches()[0].lastStates);
});
await test('提前布控首轮无货时不误报，后续到货正常提醒', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'p3.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { armedBeforeLaunch: true, product: 'iphone-18-pro-max', sku: 'MJY74CH/A', region: 'beijing' });
  await mon.tick();
  assert.equal(store.listEvents('s').length, 0, '首轮无货不该报警');
  clock.advance(60_000);
  await mon.tick();
  assert.equal(store.listEvents('s').length, 1, '随后到货应正常提醒');
});

// --------------------------------------------------------- scheduling ----
group('自适应调度');
function schedulerFixture(overrides = {}) {
  const clock = fakeClock(Date.parse('2026-09-20T03:00:00+08:00'));
  const store = { allWatches: () => [{ id: 'w' }] };
  const mon = new StockMonitor({
    inventory: { breaker: { state: 'closed', retryAfterMs: () => 0 } },
    store, catalog, notifier: null, intervalMs: 30_000, now: clock.now, ...overrides
  });
  return { mon, clock };
}
await test('无关注时退到最长间隔', () => {
  const { mon } = schedulerFixture({ store: { allWatches: () => [] } });
  assert.equal(mon.nextDelay().reason, 'idle-no-watches');
});
await test('发售窗口附近切到最快节奏', () => {
  const clock = fakeClock(Date.parse(getProduct('iphone-18-pro-max').releaseAt) - 5 * 60_000);
  const mon = new StockMonitor({
    inventory: { breaker: { state: 'closed', retryAfterMs: () => 0 } },
    store: { allWatches: () => [{ id: 'w', product: 'iphone-18-pro-max' }] },
    catalog, intervalMs: 30_000, now: clock.now
  });
  const next = mon.nextDelay();
  assert.equal(next.reason, 'drop-window');
  assert.equal(next.ms, mon.minIntervalMs);
});
await test('只有被关注机型的发售窗口才提速', () => {
  // 时钟停在 Duo 发售前 5 分钟；但只关注 18 Pro Max，不应被 Duo 的窗口带快
  const clock = fakeClock(Date.parse(getProduct('iphone-duo').releaseAt) - 5 * 60_000);
  const base = { inventory: { breaker: { state: 'closed', retryAfterMs: () => 0 } }, catalog, intervalMs: 30_000, now: clock.now };
  const onlyPro = new StockMonitor({ ...base, store: { allWatches: () => [{ id: 'w', product: 'iphone-18-pro-max' }] } });
  assert.notEqual(onlyPro.nextDelay().reason, 'drop-window', '未关注 Duo 时不该因 Duo 发售而提速');
  const withDuo = new StockMonitor({ ...base, store: { allWatches: () => [{ id: 'w', product: 'iphone-duo' }] } });
  assert.equal(withDuo.nextDelay().reason, 'drop-window');
});
await test('全部被关注机型都未开售时进入 pre-launch 节奏', () => {
  const clock = fakeClock(Date.parse('2026-10-01T00:00:00+08:00'));  // Duo 预售前
  const mon = new StockMonitor({
    inventory: { breaker: { state: 'closed', retryAfterMs: () => 0 } },
    store: { allWatches: () => [{ id: 'w', product: 'iphone-duo' }] },
    catalog, intervalMs: 30_000, now: clock.now
  });
  const next = mon.nextDelay();
  assert.equal(next.reason, 'pre-launch');
  assert.ok(next.ms > mon.baseIntervalMs, 'pre-launch 应降低频率');
});
await test('熔断打开时遵守熔断冷却而非继续压上游', () => {
  const { mon } = schedulerFixture({
    inventory: { breaker: { state: 'open', retryAfterMs: () => 45_000 } }
  });
  const next = mon.nextDelay();
  assert.equal(next.reason, 'circuit-open');
  assert.ok(next.ms >= 45_000);
});
await test('新增关注会把下一轮提前（否则要空等一个长睡眠）', () => {
  const clock = fakeClock();
  let watches = [];
  const mon = new StockMonitor({
    inventory: { breaker: { state: 'closed', retryAfterMs: () => 0 } },
    store: { allWatches: () => watches }, catalog, intervalMs: 30_000, now: clock.now
  });
  mon.stopped = false;
  mon.schedule(15 * 60_000, 'idle-no-watches');
  const far = Date.parse(mon.nextRunAt);
  watches = [{ id: 'w' }];
  assert.equal(mon.kick('watch-created'), true);
  assert.ok(Date.parse(mon.nextRunAt) < far, '新增关注后必须提前下一轮');
  assert.equal(mon.kick('again'), false, '已经很快要跑时不应重复提前');
  mon.stopped = true;
});
await test('长期无变化时逐步拉长间隔', () => {
  const { mon, clock } = schedulerFixture();
  mon.lastTransitionAt = clock.now();
  assert.equal(mon.nextDelay().reason, 'recent-movement');
  clock.advance(90 * 60_000);
  const quiet = mon.nextDelay();
  assert.equal(quiet.reason, 'steady-state');
  assert.ok(quiet.ms > mon.baseIntervalMs, '静默期应降低轮询频率');
});

// ------------------------------------------------- 前端请求竞争 -----------
group('前端请求竞争');
const SEL = (region = 'beijing') => ({ product: 'iphone-18-pro-max', capacity: '256GB', color: 'silver', region });

await test('新请求不被丢弃，且会取消在途请求', () => {
  const g = new RequestGuard();
  const first = g.begin(SEL('beijing'));
  assert.equal(first.signal.aborted, false);
  const second = g.begin(SEL('shanghai'));
  assert.equal(first.signal.aborted, true, '切换选择时旧请求必须被取消');
  assert.equal(second.seq, first.seq + 1, '新请求必须拿到更新的序号，而不是被跳过');
});
await test('旧响应即使先返回也不得渲染（序号守卫）', () => {
  const g = new RequestGuard();
  const slow = g.begin(SEL('beijing'));
  const fast = g.begin(SEL('shanghai'));
  // 慢请求此刻才返回
  assert.equal(g.isCurrent(slow, SEL('shanghai')), false, '过期请求的响应不得落地');
  assert.equal(g.isCurrent(fast, SEL('shanghai')), true);
});
await test('序号相同但选择已变回时，仍不得渲染（快照守卫）', () => {
  const g = new RequestGuard();
  const token = g.begin(SEL('beijing'));
  // 用户改到上海又改回北京之外的配置：seq 可能没变（比如只改了容量且未触发新请求）
  assert.equal(g.isCurrent(token, { ...SEL('beijing'), capacity: '1TB' }), false,
    '仅靠序号不够——选择快照也必须匹配');
  assert.equal(g.isCurrent(token, SEL('beijing')), true);
});
await test('只有最新请求拥有共享 UI（spinner / 定时器）', () => {
  const g = new RequestGuard();
  const a = g.begin(SEL('beijing'));
  const b = g.begin(SEL('shanghai'));
  assert.equal(g.owns(a), false, '旧请求 finally 不得重置 spinner 与自动刷新');
  assert.equal(g.owns(b), true);
});
await test('被取消的请求不算失败', () => {
  assert.equal(RequestGuard.isAbort({ name: 'AbortError' }), true);
  assert.equal(RequestGuard.isAbort(new Error('network')), false);
});
await test('选择快照比较覆盖全部维度', () => {
  assert.equal(sameSelection(SEL(), SEL()), true);
  for (const [k, v] of Object.entries({ product: 'iphone-duo', capacity: '1TB', color: 'black', region: 'shanghai' })) {
    assert.equal(sameSelection(SEL(), { ...SEL(), [k]: v }), false, `${k} 变化必须被发现`);
  }
  assert.equal(sameSelection(null, SEL()), false);
});
await test('端到端：慢请求返回时用户已切城，旧数据不落地', async () => {
  const g = new RequestGuard();
  const rendered = [];
  const run = async (region, delayMs) => {
    const token = g.begin(SEL(region));
    await new Promise(r => setTimeout(r, delayMs));
    if (!g.isCurrent(token, current)) return;          // 守卫
    rendered.push(region);
  };
  let current = SEL('beijing');
  const slow = run('beijing', 60);
  await new Promise(r => setTimeout(r, 10));
  current = SEL('shanghai');                            // 用户切到上海
  const fast = run('shanghai', 5);
  await Promise.all([slow, fast]);
  assert.deepEqual(rendered, ['shanghai'], `只应渲染上海，实际渲染 ${JSON.stringify(rendered)}`);
});

// ------------------------------------------------------- notifications ---
group('通知');
await test('SSE 按会话隔离投递', () => {
  const hub = new EventHub();
  const a = []; const b = [];
  hub.add('s1', { write: chunk => a.push(chunk) });
  hub.add('s2', { write: chunk => b.push(chunk) });
  hub.emit('s1', { seq: 7, storeId: 'R320' });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, '不得把事件投递给其他会话');
  assert.match(a[0], /^id: 7\nevent: stock\n/, 'SSE 必须带 id 以支持重放');
});
await test('已成功的渠道不得因其它渠道失败而重复发送（v2.2 真实缺陷）', async () => {
  const calls = { bark: 0, ntfy: 0 };
  const notifier = new Notifier({
    hub: new EventHub(), barkUrl: 'https://bark.example/k', ntfyUrl: 'https://ntfy.example/t',
    maxAttempts: 3, timeoutMs: 100, retryBaseMs: 5
  });
  globalThis.fetch = async (url) => {
    const isBark = String(url).includes('bark');
    calls[isBark ? 'bark' : 'ntfy'] += 1;
    return isBark ? { ok: true, status: 200 } : { ok: false, status: 500 };
  };
  notifier.send({ id: 'e1', sessionId: 's', watchId: 'w', storeId: 'R320', fetchedAt: 't',
    productName: 'p', capacity: '256GB', colorLabel: '银色', storeName: '三里屯', appleUrl: 'https://x' });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(calls.bark, 1, `Bark 成功后不得重发，实际 ${calls.bark} 次`);
  assert.equal(calls.ntfy, 3, `ntfy 应独立重试满 maxAttempts，实际 ${calls.ntfy} 次`);
  assert.equal(notifier.deadLetter.length, 1, '只有失败的渠道进死信');
  assert.equal(notifier.deadLetter[0].channel, 'ntfy');
});
await test('发件箱可持久化并在重启后续投', async () => {
  const store = await new StateStore(join(dir, 'ob.json'), { flushDebounceMs: 5 }).init();
  const n1 = new Notifier({ hub: new EventHub(), store, ntfyUrl: 'https://ntfy.example/t', maxAttempts: 9, timeoutMs: 50, retryBaseMs: 10_000 });
  globalThis.fetch = async () => { throw new Error('down'); };
  n1.send({ id: 'e9', sessionId: 's', watchId: 'w', storeId: 'R320', fetchedAt: 't',
    productName: 'p', capacity: '1TB', colorLabel: '黑色', storeName: '王府井', appleUrl: 'https://x' });
  await new Promise(r => setTimeout(r, 120));
  assert.ok(store.loadOutbox().queue.length > 0, '待投递项必须落盘（含退避中的任务）');
  await store.close();

  const revived = await new StateStore(join(dir, 'ob.json')).init();
  const n2 = new Notifier({ hub: new EventHub(), store: revived, ntfyUrl: 'https://ntfy.example/t', maxAttempts: 9, retryBaseMs: 10_000 });
  n2.restore();
  // restore() 立即续投，任务会移入 inflight；用 pending() 判定"仍未投递"才准确
  assert.ok(n2.pending().length > 0, '重启后应恢复未投递项，而不是静默丢弃');
  assert.equal(n2.snapshot().durable, true);
  await revived.close();
});
await test('推送失败进入重试，耗尽后落入死信', async () => {
  let attempts = 0;
  const notifier = new Notifier({
    hub: new EventHub(), ntfyUrl: 'https://ntfy.example/topic', maxAttempts: 3, timeoutMs: 100, retryBaseMs: 5
  });
  globalThis.fetch = async () => { attempts += 1; return { ok: false, status: 500 }; };
  notifier.send({ sessionId: 's', productName: 'p', capacity: '256GB', colorLabel: '银色', storeName: '三里屯', appleUrl: 'https://x' });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(attempts, 3, `应重试满 maxAttempts 次，实际 ${attempts} 次`);
  assert.equal(notifier.deadLetter.length, 1, '耗尽重试后必须落入死信');
});
await test('单个客户端写入异常不影响其他订阅者', () => {
  const hub = new EventHub();
  const good = [];
  hub.add('s', { write: () => { throw new Error('socket gone'); } });
  hub.add('s', { write: chunk => good.push(chunk) });
  assert.doesNotThrow(() => hub.emit('s', { seq: 1 }));
  assert.equal(good.length, 1);
});

await rm(dir, { recursive: true, force: true });

// ---------------------------------------------------------------- done ---
console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} 项通过, ${failures.length} 项失败\x1b[0m`);
if (failures.length) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error.stack}`);
  process.exit(1);
}
