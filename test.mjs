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
import { EventHub, Notifier, feishuSign, notifierOptionsFromEnv } from './src/notifier.mjs';
import { RequestGuard, sameSelection } from './public/request-guard.js';
import { StatsRecorder, summarize, ledger, buildIntervals, dayKey, dayStart } from './src/stats.mjs';
import { assessHealth } from './src/health.mjs';
import { chmod } from 'node:fs/promises';

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
await test('状态值全部无法识别判为硬失败（审阅 P1：否则全部 unknown 而健康全绿）', () => {
  const renamed = { pickupDisplay: 'pickup-ready-v2', messageTypes: { regular: {} } };
  const r = validateContract(wrap([
    { storeNumber: 'R320', partsAvailability: { 'A/A': renamed } },
    { storeNumber: 'R448', partsAvailability: { 'A/A': { messageTypes: { regular: {} } } } }
  ]), ['A/A']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'APPLE_STATUS_UNRECOGNIZED');
  assert.match(r.warning, /pickup-ready-v2/);
});
await test('部分状态值无法识别只记警告：可能是 Apple 新增的合法状态', () => {
  const r = validateContract(wrap([
    { storeNumber: 'R320', partsAvailability: { 'A/A': PART } },
    { storeNumber: 'R448', partsAvailability: { 'A/A': { pickupDisplay: 'reserve-only', messageTypes: { regular: {} } } } }
  ]), ['A/A']);
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.match(r.warning, /unrecognised pickupDisplay: reserve-only/);
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
// A cluster in which one Tianjin store (R638) is absent from Apple's response.
const WITHOUT_R638 = structuredClone(SAMPLE);
WITHOUT_R638.body.stores = WITHOUT_R638.body.stores.filter(store => store.storeNumber !== 'R638');
await test('覆盖图失准：邻城锚点漏店时，计划内的城市仍有结果，且下一轮立即改走本城锚点', async () => {
  const clock = fakeClock();
  const anchors = [];
  let response = WITHOUT_R638;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 60_000, retries: 0,
    fetchImpl: async url => { anchors.push(new URL(url).searchParams.get('store')); return okResponse(response); }
  });
  inv.planner.learn('R320', ['R320', 'R448', 'R479', 'R388', 'R645', 'R792', 'R579', 'R637', 'R638']);
  const plan = new Map([['beijing', ['MJY74CH/A']], ['tianjin', ['MJY74CH/A']]]);

  const first = await inv.queryPlan(plan);
  assert.deepEqual(anchors, ['R320'], '先验认为北京锚点覆盖两城');
  const tianjin = first.get('tianjin')['MJY74CH/A'];
  assert.equal(tianjin.ok, true, '天津不得整体变成 COVERAGE_MISS');
  assert.equal(tianjin.stores.find(store => store.id === 'R579').status, 'available', '响应里有的门店照常判定');
  assert.equal(tianjin.stores.find(store => store.id === 'R638').status, 'unknown', '缺席门店只能是 unknown');
  assert.equal(inv.planner.snapshot().coverageMisses, 1);

  clock.advance(1_000);                     // 远小于 fresh TTL
  response = SAMPLE;
  await inv.queryPlan(plan);
  assert.deepEqual(anchors, ['R320', 'R579'], '临时结果不得当作新鲜缓存，否则天津要空等一个 TTL');
});
await test('本城锚点自身漏店时，城市每轮都有结果（不会长期失明）', async () => {
  const clock = fakeClock();
  let calls = 0;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 1, retries: 0,
    fetchImpl: async () => { calls += 1; return okResponse(WITHOUT_R638); }
  });
  for (let round = 0; round < 3; round += 1) {
    const item = (await inv.queryPlan(new Map([['tianjin', ['MJY74CH/A']]]))).get('tianjin')['MJY74CH/A'];
    assert.equal(item.ok, true, `第 ${round + 1} 轮天津不得 COVERAGE_MISS`);
    assert.equal(item.stale, false);
    clock.advance(10);
  }
  assert.equal(calls, 3);
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
await test('Apple 限流码 541 / 429 不在请求内重试，并标记为限流', async () => {
  for (const status of [541, 429]) {
    let calls = 0;
    const error = await fetchJson('https://x', {
      retries: 2, random: () => 0,
      fetchImpl: async () => { calls += 1; return { ok: false, status, headers: { get: h => h === 'retry-after' ? '0' : null } }; }
    }).catch(e => e);
    assert.equal(calls, 1, `${status} 被限流时立即重试只会加重限流`);
    assert.equal(error.throttled, true);
    assert.equal(error.retryable, false);
  }
});
await test('非限流的非标准 5xx 仍然可重试', async () => {
  let calls = 0;
  const error = await fetchJson('https://x', {
    retries: 2, random: () => 0,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 599, headers: { get: () => null } }; }
  }).catch(e => e);
  assert.equal(calls, 3, '不能只枚举 500/502/503/504');
  assert.equal(error.throttled, false);
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
await test('状态文件存在但不可读时拒绝启动，绝不用空状态覆盖（会抹掉全部关注）', async () => {
  if (process.getuid?.() === 0) return;   // root 无视文件权限，无法构造该场景
  const path = join(dir, 'unreadable.json');
  const original = JSON.stringify({ schemaVersion: 4, seq: 1, events: [], coverage: [],
    watches: [{ id: 'w1', sessionId: 's', enabled: true, sku: 'MJY74CH/A', region: 'beijing' }] });
  await writeFile(path, original, 'utf8');
  await chmod(path, 0o000);
  try {
    await assert.rejects(() => new StateStore(path).init(), /STATE_UNREADABLE/);
  } finally {
    await chmod(path, 0o600);
  }
  assert.equal(await readFile(path, 'utf8'), original, '原状态文件必须原封不动');
});
await test('落盘持续失败时退避重试，而不是每个去抖周期刷一次错误', async () => {
  const store = await new StateStore(join(dir, 'backoff.json'), { flushDebounceMs: 5 }).init();
  const realPath = store.filePath;
  store.filePath = '/nonexistent-dir-xyz/state.json';
  store.createWatch('s', { sku: 'X', region: 'beijing' });
  await new Promise(resolve => setTimeout(resolve, 400));
  const attempts = store.stats.writeErrors;
  assert.ok(attempts >= 2, '仍需在后台重试');
  assert.ok(attempts <= 8, `400ms 内不应重试 ${attempts} 次（固定 5ms 去抖约 60 次）`);
  assert.equal(store.stats.failing, true);
  store.filePath = realPath;
  assert.equal((await store.flushNow()).ok, true, '显式落盘不受退避限制');
  assert.equal(store.stats.failing, false, '恢复后清除故障状态');
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
await test('到货记录检测间隔：本次读数与上一次读数之差', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm2-gap.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick();
  const baselineAt = store.allWatches()[0].lastCheckedAt;
  clock.advance(45_000);
  await mon.tick();
  const [event] = store.listEvents('s');
  assert.equal(event.previousCheckedAt, baselineAt, '事件带上一次读数时间');
  assert.deepEqual(mon.health().detectionGapMs, { n: 1, p50: 45_000, p95: 45_000, last: 45_000 });
  await store.close();
});
await test('Apple 改了状态字段：监控轮次算失败，健康检查报 down（端到端）', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'm-renamed.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const RENAMED = structuredClone(SAMPLE);
  for (const s of RENAMED.body.stores) for (const part of Object.values(s.partsAvailability)) part.pickupDisplay = 'pickup-ready-v2';
  const inv = monitorFixture({ clock, responses: [RENAMED] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick(); clock.advance(3_000);
  await mon.tick();
  assert.equal(mon.lastRound.checked, 0, '读不懂的响应不得算作已检查');
  const verdict = assessHealth({ inventory: inv.health(), monitor: mon.health(), state: {}, stats: {}, notifications: {} });
  assert.equal(verdict.httpStatus, 503, `应报故障，实际 ${verdict.status} ${verdict.problems.join(',')}`);
  assert.equal(inv.counters.contractFailures, 2);
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
await test('提前布控：首个读数是 stale 时不提醒、不消费标记，随后的新鲜读数立即提醒', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'p4.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const mon = new StockMonitor({ inventory: {}, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  const watch = store.createWatch('s', { armedBeforeLaunch: true, product: 'iphone-18-pro-max', sku: 'MJY74CH/A', region: 'beijing' });
  const reading = stale => ({
    ok: true, stale, staleAgeMs: stale ? 300_000 : undefined, fetchedAt: new Date(clock.now()).toISOString(),
    stores: [{ id: 'R320', name: '三里屯', status: 'available' }]
  });
  mon.evaluate(store.getWatch(watch.id), reading(true));
  assert.equal(store.listEvents('s').length, 0, '过期缓存里的有货可能早已售罄');
  assert.equal(store.getWatch(watch.id).armedBeforeLaunch, true, '标记必须留给第一个新鲜读数');
  assert.equal(store.getWatch(watch.id).lastStates, null, 'stale 读数不得成为基线');
  clock.advance(1_000);
  mon.evaluate(store.getWatch(watch.id), reading(false));
  assert.equal(store.listEvents('s').length, 1, '新鲜读数到来时立即提醒');
  await store.close();
});
await test('整轮无一关注解析成功时记录失败轮次；成功一次即清零', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'r1.json'), { flushDebounceMs: 5, now: clock.now }).init();
  let fail = true;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 1, retries: 0, failureThreshold: 100,
    fetchImpl: async () => { if (fail) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); return okResponse(SAMPLE); }
  });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing' });
  await mon.tick();  clock.advance(30_000);
  await mon.tick();
  assert.equal(mon.health().lastError, null, 'queryPlan 不抛错，lastError 看不到这种失败');
  assert.equal(mon.health().failedRounds, 2);
  assert.equal(mon.health().lastRound.checked, 0);
  fail = false;
  clock.advance(30_000);
  await mon.tick();
  assert.equal(mon.health().failedRounds, 0);
  await store.close();
});
await test('调度链断掉（下一轮严重逾期）时判定为 stalled', () => {
  const clock = fakeClock();
  const mon = new StockMonitor({ inventory: {}, store: { allWatches: () => [] }, catalog, notifier: null, now: clock.now });
  assert.equal(mon.stalled(), false, '未启动的监控不算停摆');
  mon.stopped = false;
  mon.nextRunAt = new Date(clock.now() + 30_000).toISOString();
  clock.advance(60_000);
  assert.equal(mon.stalled(), false, '稍有延迟（如休眠唤醒）不算停摆');
  clock.advance(5 * 60_000);
  assert.equal(mon.stalled(), true);
  mon.running = true;
  mon.lastRunAt = new Date(clock.now() - 60_000).toISOString();
  assert.equal(mon.stalled(), false, '正在执行的轮次不算逾期');
  mon.lastRunAt = new Date(clock.now() - 10 * 60_000).toISOString();
  assert.equal(mon.stalled(), true, '一轮卡住不结束也是停摆');
});
await test('页面查询拿到的新读数立即触发提醒，不等下一轮', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'o1.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  inv.onFresh(readings => mon.observe(readings));
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick();                                   // 基线：无货
  const roundsBefore = mon.counters.ticks;
  clock.advance(30_000);
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });   // 页面刷新
  assert.equal(mon.counters.ticks, roundsBefore, '这里没有跑监控轮');
  assert.equal(store.listEvents('s').length, 1, '页面查询发现到货应立即提醒');
  await store.close();
});
await test('跨城收割顺带拿到的城市也立即判定', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'o2.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), now: clock.now });
  inv.onFresh(readings => mon.observe(readings));
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'tianjin', capacity: '256GB', color: 'silver' });
  await mon.tick();                                   // 天津基线：无货；规划器学到簇
  clock.advance(30_000);
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });   // 有人查的是北京
  const events = store.listEvents('s');
  assert.equal(events.length, 1, '北京请求顺带收割的天津到货应立即提醒');
  assert.equal(events[0].storeId, 'R579');
  await store.close();
});
await test('本轮自身收割已判定过的读数，轮内不重复判定', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'o3.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 0, now: clock.now });
  inv.onFresh(readings => mon.observe(readings));
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick();  clock.advance(30_000);
  await mon.tick();  clock.advance(30_000);
  await mon.tick();                                   // 收割时 observe 报警一次，随后轮内判定必须跳过
  assert.equal(store.listEvents('s').length, 1, '冷却为 0 时重复判定会报两次');
  await store.close();
});
await test('乱序到达的旧读数不得回滚基线', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'o4.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const mon = new StockMonitor({ inventory: {}, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 0, now: clock.now });
  const watch = store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing' });
  const reading = (status, at) => ({ sku: 'MJY74CH/A', region: 'beijing', fetchedAt: new Date(at).toISOString(), stores: [{ id: 'R320', name: '三里屯', status }] });
  const t = clock.now();
  mon.evaluate(watch, reading('unavailable', t));         // 基线
  mon.evaluate(watch, reading('available', t + 20_000));  // 到货，报警 1
  mon.evaluate(watch, reading('unavailable', t + 10_000)); // 迟到的旧读数
  assert.equal(watch.lastStates.R320, 'available', '旧读数不得覆盖更新的基线');
  mon.evaluate(watch, reading('available', t + 30_000));
  assert.equal(store.listEvents('s').length, 1, '否则同一次到货会被再次宣布');
  await store.close();
});
await test('新读数监听器抛错不影响查询本身', async () => {
  const clock = fakeClock();
  const inv = monitorFixture({ clock, responses: [SAMPLE] });
  inv.onFresh(() => { throw new Error('listener bug'); });
  const item = await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  assert.equal(item.stores.length, 6);
});

await test('限流响应计入 throttled，供监控调速', async () => {
  const clock = fakeClock();
  let calls = 0;
  const inv = new InventoryService({
    catalog, now: clock.now, retries: 2,
    fetchImpl: async () => { calls += 1; return { ok: false, status: 541, headers: { get: () => null } }; }
  });
  await assert.rejects(inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' }));
  assert.equal(calls, 1);
  assert.equal(inv.counters.throttled, 1);
});
await test('网页自动刷新（maxAgeMs）复用监控已拿到的数据，不重复请求 Apple', async () => {
  const clock = fakeClock();
  let calls = 0;
  const inv = new InventoryService({
    catalog, now: clock.now, freshTtlMs: 12_000, retries: 0,
    fetchImpl: async () => { calls += 1; return okResponse(SAMPLE); }
  });
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  clock.advance(30_000);
  const auto = await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing', maxAgeMs: 120_000 });
  assert.equal(calls, 1, '两分钟内的缓存足够自动刷新使用');
  assert.equal(auto.cache, 'HIT');
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  assert.equal(calls, 2, '手动刷新仍然实时查询');
  clock.advance(130_000);
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing', maxAgeMs: 120_000 });
  assert.equal(calls, 3, '缓存过旧时自动刷新也要查询');
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing', maxAgeMs: 1 });
  assert.equal(calls, 3, 'maxAgeMs 只能放宽，不能比默认新鲜期更严');
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
await test('被限流时间隔加倍，恢复后逐步缩回，且不超过最长间隔', () => {
  const inventory = { breaker: { state: 'closed', retryAfterMs: () => 0 }, counters: { throttled: 0 }, upstream: { lastSuccessAt: null } };
  const { mon, clock } = schedulerFixture({ inventory });
  const base = mon.nextDelay().ms;

  inventory.counters.throttled = 1;
  mon.updatePace();
  assert.equal(mon.nextDelay().ms, base * 2, '一次限流，间隔翻倍');
  inventory.counters.throttled = 3;   // 两轮之间发生多次限流（含网页查询触发的）只算一次加倍
  mon.updatePace();
  assert.equal(mon.nextDelay().ms, base * 4);

  mon.updatePace();
  assert.equal(mon.nextDelay().ms, base * 4, '没有新的成功也没有新的限流时保持不变');
  inventory.upstream.lastSuccessAt = 't1';
  mon.updatePace();
  // Last throttle hit at 2x, so recovery halves 4x but stops at 2x * 1.25 = 2.5x.
  assert.equal(mon.nextDelay().ms, base * 2.5, '成功一轮减半，但停在被限流节奏之下');
  for (let i = 0; i < 20; i += 1) { inventory.upstream.lastSuccessAt = `t${i + 2}`; mon.updatePace(); }
  assert.equal(mon.nextDelay().ms, base * 2.5, '保持期内不回到刚被限流的节奏');
  assert.ok(mon.health().paceHoldUntil, '健康检查显示保持期');
  clock.advance(10 * 60_000);
  for (let i = 0; i < 20; i += 1) { inventory.upstream.lastSuccessAt = `u${i}`; mon.updatePace(); }
  assert.equal(mon.nextDelay().ms, base, '保持期过后回到正常节奏');
  assert.equal(mon.health().paceHoldUntil, null);

  for (let i = 0; i < 12; i += 1) { inventory.counters.throttled += 1; mon.updatePace(); }
  assert.equal(mon.nextDelay().ms, mon.maxIntervalMs, '再怎么限流也不超过最长间隔');
  assert.equal(mon.health().paceFactor, 32);
});
await test('在基准节奏被限流：一轮内恢复到 1.25 倍并保持，不再每隔几轮撞一次限流', () => {
  const inventory = { breaker: { state: 'closed', retryAfterMs: () => 0 }, counters: { throttled: 0 }, upstream: { lastSuccessAt: null } };
  const { mon, clock } = schedulerFixture({ inventory });
  const base = mon.nextDelay().ms;
  inventory.counters.throttled = 1;
  mon.updatePace();
  inventory.upstream.lastSuccessAt = 's1';
  mon.updatePace();
  assert.equal(mon.nextDelay().ms, base * 1.25, '一轮成功即回到被限流节奏的 1.25 倍');
  clock.advance(9 * 60_000);
  inventory.upstream.lastSuccessAt = 's2';
  mon.updatePace();
  assert.equal(mon.nextDelay().ms, base * 1.25, '10 分钟内保持');
  clock.advance(60_000);
  inventory.upstream.lastSuccessAt = 's3';
  mon.updatePace();
  assert.equal(mon.nextDelay().ms, base, '保持期满再回到全速');
});
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
await test('重启后不会直接跳到最慢间隔（lastTransitionAt 初始为 0）', () => {
  const { mon } = schedulerFixture();
  const next = mon.nextDelay();
  assert.equal(next.reason, 'steady-state');
  assert.equal(next.ms, mon.baseIntervalMs, '刚启动时静默时长应从启动时刻算起');
});
await test('有关注时静默期间隔不超过 quietMaxIntervalMs', () => {
  const { mon, clock } = schedulerFixture();
  clock.advance(12 * 60 * 60_000);
  assert.equal(mon.nextDelay().ms, 60_000);
  const custom = schedulerFixture({ quietMaxIntervalMs: 45_000 });
  custom.clock.advance(12 * 60 * 60_000);
  assert.equal(custom.mon.nextDelay().ms, 45_000);
  const belowBase = schedulerFixture({ quietMaxIntervalMs: 5_000 });
  assert.equal(belowBase.mon.nextDelay().ms, belowBase.mon.baseIntervalMs, '上限不得低于基准节奏');
});


await test('暂停监控：不调度、不被 kick 唤醒，恢复后立即重新调度', () => {
  const { mon } = schedulerFixture();
  mon.start();
  assert.ok(mon.timer, '启动后应有定时器');
  assert.equal(mon.pause(), true);
  assert.equal(mon.pause(), false, '重复暂停是空操作');
  assert.equal(mon.timer, null, '暂停必须清掉定时器');
  assert.equal(mon.nextRunAt, null);
  assert.equal(mon.kick('watch-created'), false, '新增关注不能唤醒已暂停的监控');
  mon.start();
  assert.equal(mon.timer, null, '暂停期间 start() 不应恢复调度（重启时恢复暂停状态靠这一点）');
  assert.equal(mon.stalled(), false, '暂停不是停摆');
  assert.equal(mon.health().paused, true);

  mon.failedRounds = 3;
  mon.lastRound = { checked: 0, errored: 2 };
  assert.equal(mon.resume(), true);
  assert.ok(mon.timer, '恢复后应重新调度');
  assert.equal(mon.failedRounds, 0, '暂停前的轮次结果不应带到恢复之后');
  assert.equal(mon.lastRound, null);
  mon.stop();
});
await test('暂停期间网页查询带来的新鲜读数不会触发到货', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'pause-observe.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const mon = new StockMonitor({ inventory: {}, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 0, now: clock.now });
  const watch = store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  store.updateWatchSnapshot(watch.id, { R320: 'unavailable' }, new Date(clock.now()).toISOString());
  clock.advance(1_000);
  const reading = { sku: 'MJY74CH/A', region: 'beijing', fetchedAt: new Date(clock.now()).toISOString(), stores: [{ id: 'R320', name: '三里屯', status: 'available' }] };

  mon.pause();
  mon.observe([reading]);
  assert.equal(store.listEvents('s').length, 0, '暂停期间不得报警');
  assert.equal(store.allWatches()[0].lastStates.R320, 'unavailable', '暂停期间基线不应前移，否则恢复后会漏报');

  mon.resume(); mon.stop();
  mon.observe([reading]);
  assert.equal(store.listEvents('s').length, 1, '恢复后同样的变化应当报警');
  await store.close();
});
await test('暂停期间在途的一轮读数被丢弃，不报警也不记错误', async () => {
  const clock = fakeClock();
  const store = await new StateStore(join(dir, 'pause-inflight.json'), { flushDebounceMs: 5, now: clock.now }).init();
  const inv = monitorFixture({ clock, responses: [NONE, SAMPLE] });
  const mon = new StockMonitor({ inventory: inv, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 0, now: clock.now });
  store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
  await mon.tick();                        // 基线
  clock.advance(60_000);
  const round = mon.tick();
  mon.pause();                             // 请求发出后才暂停
  await round;
  assert.equal(store.listEvents('s').length, 0);
  assert.equal(store.allWatches()[0].consecutiveErrors, 0);
  await store.close();
});
await test('暂停开关持久化，重启后仍为暂停', async () => {
  const file = join(dir, 'control.json');
  const first = await new StateStore(file, { flushDebounceMs: 5 }).init();
  assert.deepEqual(first.loadControl(), {});
  first.saveControl({ monitorPaused: true, monitorPausedAt: '2026-09-15T02:00:00.000Z' });
  await first.close();
  const second = await new StateStore(file).init();
  assert.equal(second.loadControl().monitorPaused, true);
  assert.equal(second.loadControl().monitorPausedAt, '2026-09-15T02:00:00.000Z');
  await second.close();
});

// ------------------------------------------------------------ 到货统计 -----
group('到货统计');
const T0 = Date.parse('2026-09-18T08:00:00+08:00');
const at = min => new Date(T0 + min * 60_000).toISOString();
const store = (id, status) => ({ id, name: id, status });
async function recorderAt(name, clock) {
  return new StatsRecorder({ dir: join(dir, name), catalog, now: clock.now, flushDebounceMs: 5 }).init();
}

await test('按北京时间切日', () => {
  assert.equal(dayKey(Date.parse('2026-09-17T16:00:00Z')), '2026-09-18', 'UTC 16:00 = 北京次日 00:00');
  assert.equal(dayKey(Date.parse('2026-09-17T15:59:59Z')), '2026-09-17');
  assert.equal(dayStart('2026-09-18'), Date.parse('2026-09-18T00:00:00+08:00'));
});
await test('首次看到有货只记 baseline，不算上架', async () => {
  const clock = fakeClock(T0);
  const rec = await recorderAt('s1', clock);
  const out = rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'available')], fetchedAt: at(0) });
  assert.deepEqual(out.map(e => e.type), ['baseline']);
  await rec.close();
});
await test('无货 → 有货 记上架；有货 → 无货 记售罄并算出时长', async () => {
  const clock = fakeClock(T0);
  const rec = await recorderAt('s2', clock);
  const obs = (min, status) => rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', status)], fetchedAt: at(min) });
  obs(0, 'unavailable');
  assert.deepEqual(obs(10, 'available').map(e => e.type), ['up']);
  assert.deepEqual(obs(11, 'available'), [], '持续有货不重复记');
  const [down] = obs(22.5, 'unavailable');
  assert.equal(down.type, 'down');
  assert.equal(down.durationMs, 12.5 * 60_000);
  assert.equal(down.capacity, '256GB');
  assert.equal(down.colorLabel, '银色');
  assert.equal(down.region, 'beijing');
  await rec.close();
});
await test('unknown 不改变状态，绝不记为售罄', async () => {
  const clock = fakeClock(T0);
  const rec = await recorderAt('s3', clock);
  const obs = (min, status) => rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', status)], fetchedAt: at(min) });
  obs(0, 'unavailable'); obs(5, 'available');
  assert.deepEqual(obs(6, 'unknown'), [], '查询失败不是售罄');
  assert.deepEqual(obs(7, 'available'), [], 'unknown 之后恢复有货也不是新的上架');
  await rec.close();
});
await test('同一 SKU×门店 被多次读取（多人关注/跨城收割）不重复计数', async () => {
  const clock = fakeClock(T0);
  const rec = await recorderAt('s4', clock);
  rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'unavailable')], fetchedAt: at(0) });
  const first = rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'available')], fetchedAt: at(1) });
  const again = rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'available')], fetchedAt: at(1) });
  assert.equal(first.length + again.length, 1);
  await rec.close();
});
await test('事件与计数落盘，重启后状态可恢复且跨重启的变化标记为不确定', async () => {
  const clock = fakeClock(T0);
  const rec = await recorderAt('s5', clock);
  rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'unavailable')], fetchedAt: at(0) });
  rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'available')], fetchedAt: at(3) });
  rec.count('pageQueries', 5); rec.count('cacheHits', 2);
  await rec.close();

  clock.advance(30 * 60_000);
  const revived = await recorderAt('s5', clock);
  assert.equal(revived.counters.pageQueries, 5, '当天计数重启后保留');
  const [down] = revived.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', 'unavailable')], fetchedAt: at(40) });
  assert.equal(down.type, 'down', '重启前的有货状态必须恢复，否则售罄会丢');
  assert.equal(down.durationMs, 37 * 60_000);
  assert.equal(down.uncertain, true, '中间停机过，时长可能不准，必须标注');
  const events = await revived.readEvents('2026-09-18');
  assert.deepEqual(events.map(e => e.type), ['up', 'down']);
  await revived.close();
});
await test('跨日时仍有货的门店写入 carry，且不覆盖昨天的计数', async () => {
  const clock = fakeClock(Date.parse('2026-09-18T23:50:00+08:00'));
  const rec = await recorderAt('s6', clock);
  rec.observe({ sku: 'MJYK4CH/A', regionId: 'shanghai', stores: [store('R401', 'unavailable')], fetchedAt: new Date(clock.now()).toISOString() });
  clock.advance(60_000);
  rec.observe({ sku: 'MJYK4CH/A', regionId: 'shanghai', stores: [store('R401', 'available')], fetchedAt: new Date(clock.now()).toISOString() });
  rec.count('monitorRounds', 7);
  clock.set(Date.parse('2026-09-19T00:05:00+08:00'));
  rec.count('monitorRounds', 1);
  await rec.close();

  const today = await rec.readEvents('2026-09-19');
  assert.equal(today[0]?.type, 'carry', '新的一天应以 carry 开头');
  const y = JSON.parse(await readFile(join(dir, 's6', 'counters-2026-09-18.json'), 'utf8'));
  assert.equal(y.counters.monitorRounds, 7, '昨天的计数不得被清零覆盖');
});
await test('记录最近一次检查时间，并能找到最近一次到货', async () => {
  const clock = fakeClock(Date.parse('2026-09-12T20:00:00+08:00'));
  const rec = await recorderAt('s8', clock);
  const obs = (iso, status) => rec.observe({ sku: 'MJY74CH/A', regionId: 'beijing', stores: [store('R320', status)], fetchedAt: iso });
  obs('2026-09-12T20:00:00+08:00', 'unavailable');
  obs('2026-09-12T20:31:00+08:00', 'available');
  clock.set(Date.parse('2026-09-13T13:40:00+08:00'));
  obs('2026-09-13T13:40:00+08:00', 'available');
  assert.equal(rec.lastObservedAt, new Date('2026-09-13T13:40:00+08:00').toISOString());
  const last = await rec.lastArrival('iphone-18-pro-max', '2026-09-13');
  assert.equal(last.day, '2026-09-12', '今天只有 carry 没有新的到货，应回溯到昨天');
  assert.equal(last.t, new Date('2026-09-12T20:31:00+08:00').toISOString());
  assert.equal(await rec.lastArrival('iphone-duo', '2026-09-13'), null);
  assert.deepEqual(rec.coverage('iphone-18-pro-max'), { configs: 1, stores: 1, regions: 1 });
  assert.deepEqual(rec.coverage('iphone-duo'), { configs: 0, stores: 0, regions: 0 });
  await rec.close();
  const saved = JSON.parse(await readFile(join(dir, 's8', 'counters-2026-09-13.json'), 'utf8'));
  assert.ok(saved.lastObservedAt, '最近检查时间要落盘');
});
await test('在新的一天启动的进程不会用空计数覆盖昨天', async () => {
  const clock = fakeClock(Date.parse('2026-09-18T20:00:00+08:00'));
  const rec = await recorderAt('s7', clock);
  rec.count('pageQueries', 42);
  await rec.close();
  clock.set(Date.parse('2026-09-19T09:00:00+08:00'));
  const next = await recorderAt('s7', clock);
  next.count('pageQueries', 1);
  await next.close();
  const y = JSON.parse(await readFile(join(dir, 's7', 'counters-2026-09-18.json'), 'utf8'));
  assert.equal(y.counters.pageQueries, 42);
});
await test('区间重建：carry 从零点起算，未售罄的区间保持开放', () => {
  const start = dayStart('2026-09-18');
  const intervals = buildIntervals([
    { t: new Date(start).toISOString(), type: 'carry', sku: 'A', storeId: 'R1' },
    { t: at(0), type: 'down', sku: 'A', storeId: 'R1' },
    { t: at(5), type: 'up', sku: 'A', storeId: 'R2' }
  ], start);
  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].start, start);
  assert.equal(intervals[0].end, T0);
  assert.equal(intervals[1].end, null);
});
await test('汇总：上架/售罄/峰值/平均时长/排行口径正确', () => {
  const ev = (min, type, sku, storeId, extra = {}) => ({ t: at(min), type, sku, storeId, region: 'beijing', product: 'iphone-18-pro-max', capacity: sku === 'S1' ? '256GB' : '1TB', colorLabel: '银色', ...extra });
  const events = [
    ev(0, 'up', 'S1', 'R1'), ev(0, 'up', 'S1', 'R2'), ev(10, 'down', 'S1', 'R1', { durationMs: 600_000 }),
    ev(20, 'up', 'S2', 'R1'), ev(50, 'down', 'S2', 'R1', { durationMs: 1_800_000, uncertain: true }),
    ev(1, 'baseline', 'S2', 'R3')
  ];
  const sum = summarize({ day: '2026-09-18', events, counters: {}, firstObservedAt: at(0), product: 'iphone-18-pro-max', catalog, now: T0 + 120 * 60_000 });
  assert.equal(sum.totals.ups, 3);
  assert.equal(sum.totals.downs, 2);
  assert.equal(sum.totals.baselines, 1, 'baseline 单独计，不混入上架');
  assert.equal(sum.totals.avgDurationMin, 10, '不确定的时长不参与平均');
  assert.equal(sum.totals.peak.value, 3, '5 分钟时刻 R1/R2 的 S1 + R3 的 baseline');
  assert.equal(sum.ranking[0].sku, 'S1');
  assert.equal(sum.ranking[0].stores, 2);
  assert.equal(sum.window.start, at(0), '图表从首次观测的整点开始');
});
await test('明细：筛选、最新在前、同城该配置有货数', () => {
  const ev = (min, type, storeId, extra = {}) => ({ t: at(min), type, sku: 'S1', storeId, region: 'beijing', product: 'p', capacity: '256GB', ...extra });
  const events = [ev(0, 'up', 'R1'), ev(2, 'up', 'R2'), ev(9, 'down', 'R1', { durationMs: 540_000 }), { ...ev(3, 'up', 'R9'), region: 'shanghai' }];
  const all = ledger({ day: '2026-09-18', events });
  assert.deepEqual(all.rows.map(r => r.t), [at(9), at(3), at(2), at(0)]);
  const r2 = all.rows.find(r => r.storeId === 'R2');
  assert.equal(r2.sameCityAvailable, 2, 'R2 上架时北京已有 R1 + 自己');
  const down = all.rows.find(r => r.type === 'down');
  assert.equal(down.sameCityAvailable, 1, '售罄那一刻不含自己');
  assert.equal(all.rows.find(r => r.storeId === 'R1' && r.type === 'up').windowMs, 540_000);
  assert.equal(ledger({ day: '2026-09-18', events, filters: { region: 'shanghai' } }).total, 1);
  assert.equal(ledger({ day: '2026-09-18', events, filters: { type: 'down' } }).total, 1);
});
await test('汇总只统计当前机型，并按小时给出到货与售罄', () => {
  const mk = (min, type, sku, product, storeId = 'R1') => ({ t: at(min), type, sku, storeId, region: 'beijing', product, capacity: '256GB', color: 'silver', colorLabel: '银色', durationMs: type === 'down' ? 60_000 : undefined });
  const events = [
    mk(0, 'up', 'MJY74CH/A', 'iphone-18-pro-max'), mk(70, 'down', 'MJY74CH/A', 'iphone-18-pro-max'),
    mk(75, 'up', 'MJY74CH/A', 'iphone-18-pro-max', 'R2'),
    mk(5, 'up', 'MK2M4CH/A', 'iphone-duo')
  ];
  const sum = summarize({ day: '2026-09-18', events, counters: {}, firstObservedAt: at(0), product: 'iphone-18-pro-max', catalog, now: T0 + 180 * 60_000 });
  assert.equal(sum.totals.ups, 2, 'Duo 的到货不得混入 18 Pro Max 的数字');
  assert.deepEqual(sum.products.sort(), ['iphone-18-pro-max', 'iphone-duo'], '可切换的机型列表仍包含全部');
  assert.deepEqual(sum.hourly[8], { hour: 8, up: 1, down: 0 });
  assert.deepEqual(sum.hourly[9], { hour: 9, up: 1, down: 1 });
  assert.equal(sum.hourlyUpBySku['MJY74CH/A'][9], 1);
  assert.equal(sum.hourRange.from, 8);
  assert.equal(sum.hourRange.to, 10);
  assert.equal(sum.totals.storesAvailableNow, 1, '只有 R2 仍有货');
  assert.equal(sum.ranking[0].swatch, catalog.products['iphone-18-pro-max'].colors.find(c => c.id === 'silver').swatch);
});
await test('明细可按配置和小时筛选', () => {
  const mk = (min, sku) => ({ t: at(min), type: 'up', sku, storeId: 'R1', region: 'beijing', product: 'p', capacity: '256GB' });
  const events = [mk(0, 'A'), mk(10, 'B'), mk(65, 'A')];
  assert.equal(ledger({ day: '2026-09-18', events, filters: { sku: 'A' } }).total, 2);
  assert.equal(ledger({ day: '2026-09-18', events, filters: { hour: 8 } }).total, 2);
  assert.equal(ledger({ day: '2026-09-18', events, filters: { sku: 'A', hour: 9 } }).total, 1);
  assert.equal(ledger({ day: '2026-09-18', events, filters: { hour: 0 } }).total, 0, '0 点是有效筛选值，不能被当成"未筛选"');
});
await test('明细的每小时计数基于全部筛选结果，而不是当前加载的一页', () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ t: at(i), type: 'up', sku: 'S' + i, storeId: 'R1', region: 'beijing', product: 'p', capacity: '256GB' }));
  const page = ledger({ day: '2026-09-18', events, limit: 5 });
  assert.equal(page.rows.length, 5);
  assert.equal(page.hourCounts[8].up, 30, '08 点应计 30 次上架，而非页面上的 5 条');
});
await test('库存服务把新鲜数据喂给统计，缓存命中不喂', async () => {
  const seen = [];
  const counts = {};
  const recorder = { observe: o => seen.push(o), count: (k, n = 1) => { counts[k] = (counts[k] || 0) + n; } };
  const inv = new InventoryService({ catalog, freshTtlMs: 60_000, recorder, fetchImpl: async () => okResponse(SAMPLE) });
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  const afterFirst = seen.length;
  await inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' });
  assert.ok(afterFirst >= 1);
  assert.equal(seen.length, afterFirst, '缓存命中不得再次观测，否则会重复记录');
  assert.equal(counts.appleRequests, 1);
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
await test('卡死的渠道不得拖慢其它渠道（2026-10-25 实测 Bark 被拖 6.4s）', async () => {
  const barkAt = [];
  const started = Date.now();
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    if (String(url).startsWith('https://ntfy.hol/')) {
      // Dead channel: never answers, only gives up when the per-delivery timeout aborts it.
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      return;
    }
    if (String(url).startsWith('https://bark.hol/')) barkAt.push(Date.now() - started);
    resolve({ ok: true, status: 200 });
  });
  const notifier = new Notifier({
    hub: new EventHub(), barkUrl: 'https://bark.hol/k', ntfyUrl: 'https://ntfy.hol/t',
    maxAttempts: 2, timeoutMs: 1_000, retryBaseMs: 5
  });
  const arrival = (id, storeName) => ({ id, sessionId: 's', productName: 'p', capacity: '256GB', colorLabel: '黑色', storeName, appleUrl: 'https://x' });
  notifier.send(arrival('h1', '三里屯'));
  await new Promise(r => setTimeout(r, 30));
  notifier.send(arrival('h2', '王府井'));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(barkAt.length, 2, `ntfy 卡住时 Bark 仍应立即送出第二条，实际只送出 ${barkAt.length} 条`);
  assert.ok(barkAt[1] < 150, `第二条 Bark 延迟 ${barkAt[1]}ms`);
  assert.ok(notifier.pending().some(job => job.channel === 'ntfy'), 'ntfy 仍在独立重试');
});
await test('按渠道统计送达延迟；冷却窗口有意暂存的推送不计入', async () => {
  const clock = fakeClock();
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  const notifier = new Notifier({ hub: new EventHub(), barkUrl: 'https://bark.lat/k', timeoutMs: 100, now: clock.now });
  const at = offset => new Date(clock.now() - offset).toISOString();
  notifier.send({ id: 'l1', sessionId: 's', productName: 'p', capacity: '256GB', colorLabel: '黑色', storeName: '三里屯',
    appleUrl: 'https://x', fetchedAt: at(1_500), createdAt: at(200) });
  await new Promise(r => setTimeout(r, 20));
  const [bark] = notifier.snapshot().channels;
  assert.deepEqual(bark.latencyMs.fromRead, { n: 1, p50: 1_500, p95: 1_500, last: 1_500 }, '从 Apple 读数到送达');
  assert.equal(bark.latencyMs.fromRaise.p50, 200, '从触发提醒到送达');
  notifier.recordLatency(notifier.channels[0], { held: true, fetchedAt: at(60_000), createdAt: at(60_000) });
  assert.equal(notifier.snapshot().channels[0].latencyMs.fromRead.n, 1, '暂存推送的延迟是有意的，不得计入');
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
  // Count only this test's endpoint: notifiers from earlier tests may still be backing off and
  // would otherwise land on this replaced global fetch, making the count timing-dependent.
  globalThis.fetch = async url => { if (String(url) === 'https://ntfy.example/topic') attempts += 1; return { ok: false, status: 500 }; };
  notifier.send({ sessionId: 's', productName: 'p', capacity: '256GB', colorLabel: '银色', storeName: '三里屯', appleUrl: 'https://x' });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(attempts, 3, `应重试满 maxAttempts 次，实际 ${attempts} 次`);
  assert.equal(notifier.deadLetter.length, 1, '耗尽重试后必须落入死信');
});
await test('飞书：带签名发送，HTTP 200 但 code≠0 视为失败并重试', async () => {
  const bodies = [];
  const replies = [{ code: 19021, msg: 'sign match fail or timestamp is not within one hour from current time' }, { code: 0, msg: 'success' }];
  const notifier = new Notifier({
    hub: new EventHub(), feishuUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', feishuSecret: 'sec',
    maxAttempts: 3, timeoutMs: 100, retryBaseMs: 5
  });
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/bot/v2/hook/abc')) return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    bodies.push(JSON.parse(init.body));
    const reply = replies.shift();
    return { ok: true, status: 200, json: async () => reply };
  };
  notifier.send({ id: 'f1', sessionId: 's', productName: 'iPhone 18 Pro Max', capacity: '256GB', colorLabel: '银色', storeName: '三里屯', appleUrl: 'https://apple.example/buy' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(bodies.length, 2, '被飞书拒收的消息必须重试，而不是记为已发送');
  const [channel] = notifier.snapshot().channels;
  assert.equal(channel.sent, 1);
  assert.equal(channel.failed, 1);
  assert.match(channel.lastError, /FEISHU_REJECTED_19021/);
  const body = bodies[1];
  assert.equal(body.sign, feishuSign(body.timestamp, 'sec'), '签名必须按飞书算法生成');
  assert.equal(body.msg_type, 'post');
  assert.match(JSON.stringify(body.content), /三里屯/);
  assert.match(JSON.stringify(body.content), /https:\/\/apple\.example\/buy/);
});
await test('Bark 默认响铃醒目：持续铃声 + 时效性通知', () => {
  const event = { productName: 'p', capacity: '256GB', colorLabel: '银色', storeName: '三里屯', appleUrl: 'https://x' };
  const payload = n => JSON.parse(n.channels[0].build(n.channels[0].url, event).init.body);

  const loud = payload(new Notifier({ hub: new EventHub(), ...notifierOptionsFromEnv({ BARK_URL: 'https://api.day.app/k/' }) }));
  assert.equal(loud.sound, 'shake');
  assert.equal(loud.call, '1', '默认应持续响铃');
  assert.equal(loud.level, 'timeSensitive');
  assert.equal(loud.volume, undefined, 'volume 只对 critical 生效');

  const critical = new Notifier({ hub: new EventHub(), ...notifierOptionsFromEnv({ BARK_URL: 'https://api.day.app/k', BARK_LEVEL: 'critical', BARK_VOLUME: '7' }) });
  assert.equal(payload(critical).level, 'critical');
  assert.equal(payload(critical).volume, 7);

  const quiet = payload(new Notifier({ hub: new EventHub(), ...notifierOptionsFromEnv({ BARK_URL: 'https://api.day.app/k', BARK_SOUND: '', BARK_CALL: '0', BARK_LEVEL: 'bogus' }) }));
  assert.equal(quiet.sound, undefined, '留空则用系统默认铃声');
  assert.equal(quiet.call, undefined);
  assert.equal(quiet.level, 'timeSensitive', '无效级别回退为 timeSensitive');
});
await test('Bark 地址末尾多余的斜杠会被去掉', () => {
  const notifier = new Notifier({ hub: new EventHub(), barkUrl: 'https://api.day.app/k//' });
  assert.equal(notifier.channels[0].url, 'https://api.day.app/k');
});
await test('企业微信与 PushPlus：按各自响应体判定成败', async () => {
  const seen = {};
  const notifier = new Notifier({
    hub: new EventHub(), wecomUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1', pushplusToken: 'tok',
    maxAttempts: 1, timeoutMs: 100, retryBaseMs: 5
  });
  // Parse only this test's endpoints: notifiers from earlier tests may still be backing off
  // and land here with non-JSON bodies.
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('qyapi.weixin.qq.com')) {
      seen.wecom = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ errcode: 93000, errmsg: 'invalid webhook url' }) };
    }
    if (String(url) === 'https://www.pushplus.plus/send') {
      seen.pushplus = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ code: 200, msg: '请求成功' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  notifier.send({ id: 'w1', sessionId: 's', productName: 'p', capacity: '1TB', colorLabel: '黑色', storeName: '王府井', appleUrl: 'https://x' });
  await new Promise(r => setTimeout(r, 200));
  const byName = Object.fromEntries(notifier.snapshot().channels.map(c => [c.name, c]));
  assert.equal(byName.wecom.sent, 0, 'errcode≠0 不得记为已发送');
  assert.match(byName.wecom.lastError, /WECOM_REJECTED_93000/);
  assert.equal(byName.pushplus.sent, 1);
  assert.equal(seen.wecom.msgtype, 'text', '企业微信用纯文本，微信插件里 markdown 显示不出来');
  assert.match(seen.wecom.text.content, /王府井/);
  assert.equal(seen.pushplus.token, 'tok');
  assert.equal(notifier.deadLetter.filter(d => d.channel === 'wecom').length, 1);
});
await test('单个客户端写入异常不影响其他订阅者', () => {
  const hub = new EventHub();
  const good = [];
  hub.add('s', { write: () => { throw new Error('socket gone'); } });
  hub.add('s', { write: chunk => good.push(chunk) });
  assert.doesNotThrow(() => hub.emit('s', { seq: 1 }));
  assert.equal(good.length, 1);
});

// ------------------------------------------------------------- health -----
group('健康检查');
const healthy = () => ({
  inventory: { circuit: { state: 'closed' }, upstream: {} },
  monitor: { stalled: false, lastError: null, failedRounds: 0, lastRound: { checked: 3, errored: 0 } },
  state: { failing: false }, stats: { writeFailing: false }, notifications: { lastDeadLetterAt: null },
  now: Date.parse('2026-09-20T10:00:00Z')
});
await test('一切正常时 ok / 200 且无原因', () => {
  assert.deepEqual(assessHealth(healthy()), { status: 'ok', httpStatus: 200, problems: [], warnings: [] });
});
await test('无法发现到货（停摆 / 连续整轮失败 / 熔断）返回 503', () => {
  for (const [mutate, reason] of [
    [h => { h.monitor.stalled = true; }, 'monitor-stalled'],
    [h => { h.monitor.failedRounds = 2; h.monitor.lastRound = { checked: 0, errored: 3 }; }, 'rounds-failing'],
    [h => { h.inventory.circuit.state = 'open'; }, 'circuit-open']
  ]) {
    const input = healthy();
    mutate(input);
    const verdict = assessHealth(input);
    assert.equal(verdict.httpStatus, 503, reason);
    assert.ok(verdict.problems.includes(reason));
  }
});
await test('单轮整体失败只算降级，不让探针抖动', () => {
  const input = healthy();
  input.monitor.failedRounds = 1;
  input.monitor.lastRound = { checked: 0, errored: 3 };
  const verdict = assessHealth(input);
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.httpStatus, 200);
});
await test('持久化失败、统计写入失败、近期死信：降级但仍为 200，且列出原因', () => {
  const input = healthy();
  input.state.failing = true;
  input.stats.writeFailing = true;
  input.notifications.lastDeadLetterAt = new Date(input.now - 5 * 60_000).toISOString();
  const verdict = assessHealth(input);
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.httpStatus, 200, '提醒仍在正常工作，不能让守护进程重启它');
  assert.deepEqual(verdict.warnings, ['state-persist-failing', 'stats-write-failing', 'notification-dead-lettered']);

  input.state.failing = false;
  input.stats.writeFailing = false;
  input.notifications.lastDeadLetterAt = new Date(input.now - 2 * 3600_000).toISOString();
  assert.equal(assessHealth(input).status, 'ok', '很久以前的死信不应永久挂黄');
});

await test('主动暂停：降级但仍为 200，且屏蔽暂停前遗留的轮次故障', () => {
  const input = healthy();
  input.monitor.paused = true;
  input.monitor.failedRounds = 5;
  input.monitor.lastRound = { checked: 0, errored: 3 };
  input.monitor.lastError = 'boom';
  const verdict = assessHealth(input);
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.httpStatus, 200, '暂停是有意为之，不能让守护进程重启它');
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.warnings, ['monitor-paused']);
});
await test('EventHub.broadcast 发给所有会话', () => {
  const hub = new EventHub();
  const got = [];
  hub.add('a', { write: chunk => got.push(['a', chunk]) });
  hub.add('b', { write: chunk => got.push(['b', chunk]) });
  assert.equal(hub.broadcast({ paused: true }, 'monitor'), 2);
  assert.ok(got.every(([, chunk]) => chunk.startsWith('event: monitor\n')));
});

// ------------------------------------------------- 2026-10-25 回归 ---
group('到货判定与推送合并（2026-10-25 修复）');

function evalHarness(file) {
  const clock = fakeClock();
  return (async () => {
    const store = await new StateStore(join(dir, file), { flushDebounceMs: 5, now: clock.now }).init();
    const mon = new StockMonitor({ inventory: {}, store, catalog, notifier: new Notifier({ hub: new EventHub() }), alertCooldownMs: 2 * 60_000, now: clock.now });
    const watch = store.createWatch('s', { sku: 'MJY74CH/A', region: 'beijing', capacity: '256GB', color: 'silver' });
    const feed = status => mon.evaluate(store.getWatch(watch.id), {
      ok: true, stale: false, fetchedAt: new Date(clock.now()).toISOString(),
      stores: [{ id: 'R320', name: '三里屯', status }]
    });
    return { clock, store, feed };
  })();
}

await test('门店一轮缺席（unknown）不得把一直有货误报为到货', async () => {
  const { clock, store, feed } = await evalHarness('r1.json');
  feed('available');                 // 基线：有货
  clock.advance(15 * 60_000); feed('available');
  clock.advance(3_000); feed('unknown');      // Apple 这一轮漏了这家店
  clock.advance(3_000); feed('available');    // 又出现，仍有货
  assert.equal(store.listEvents('s').length, 0, '一直有货，不是到货');
  assert.equal(store.getWatch(store.allWatches()[0].id).lastStates.R320, 'available', 'unknown 不得覆盖已知状态');
  await store.close();
});
await test('无货 → 缺席 → 有货 仍然是真实到货', async () => {
  const { clock, store, feed } = await evalHarness('r2.json');
  feed('unavailable');
  clock.advance(3_000); feed('unknown');
  clock.advance(3_000); feed('available');
  assert.equal(store.listEvents('s').length, 1);
  assert.equal(store.listEvents('s')[0].previousStatus, 'unavailable', '上一个已知状态是无货');
  await store.close();
});
await test('从未确认过的门店首次有货仍算到货', async () => {
  const { clock, store, feed } = await evalHarness('r3.json');
  feed('unknown');
  clock.advance(3_000); feed('available');
  assert.equal(store.listEvents('s').length, 1);
  await store.close();
});
await test('单店冷却 2 分钟：卖完后很快补货也会提醒', async () => {
  const { clock, store, feed } = await evalHarness('r4.json');
  feed('unavailable');
  clock.advance(3_000); feed('available');            // 提醒 1
  clock.advance(60_000); feed('unavailable');          // 卖完
  clock.advance(90_000); feed('available');            // 2.5 分钟后补货
  assert.equal(store.listEvents('s').length, 2);
  await store.close();
});

const arrival = (id, storeName, extra = {}) => ({
  id, sessionId: 's', sku: 'MJY74CH/A', productName: 'iPhone 18 Pro Max', capacity: '256GB',
  colorLabel: '银色', storeName, storeId: id, fetchedAt: new Date().toISOString(), appleUrl: 'https://x', ...extra
});

await test('推送冷却窗口内的到货不丢弃，窗口结束后合并成一条推送', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://bark.merge/')) bodies.push(JSON.parse(init.body).body);
    return { ok: true, status: 200 };
  };
  const notifier = new Notifier({ hub: new EventHub(), barkUrl: 'https://bark.merge/k', pushCooldownMs: 300, retryBaseMs: 5, timeoutMs: 100 });
  notifier.send(arrival('a1', '三里屯'));
  await new Promise(r => setTimeout(r, 50));
  notifier.send(arrival('a2', '王府井'));
  notifier.send(arrival('a3', '王府井'));
  notifier.send(arrival('a4', '西单大悦城'));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(bodies.length, 1, '窗口内不应再推');
  assert.equal(notifier.snapshot().deferred, 3);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(bodies.length, 2, `窗口结束后应补发一条合并推送，实际 ${bodies.length}`);
  assert.match(bodies[1], /王府井、西单大悦城/);
  assert.equal(bodies[1].match(/王府井/g).length, 1, '同一门店只列一次');
  assert.equal(notifier.snapshot().deferred, 0);
});
await test('所有渠道都失败的推送不占用冷却窗口', async () => {
  let fail = true;
  const delivered = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://bark.fail/')) return { ok: true, status: 200 };
    if (fail) { fail = false; return { ok: false, status: 500 }; }
    delivered.push(JSON.parse(init.body).body);
    return { ok: true, status: 200 };
  };
  const notifier = new Notifier({ hub: new EventHub(), barkUrl: 'https://bark.fail/k', pushCooldownMs: 60_000, maxAttempts: 1, retryBaseMs: 5, timeoutMs: 100 });
  notifier.send(arrival('b1', '三里屯'));     // 唯一渠道失败 → 死信
  notifier.send(arrival('b2', '王府井'));     // 发送中到达 → 暂存
  await new Promise(r => setTimeout(r, 150));
  assert.equal(delivered.length, 1, '第一条失败，窗口未被占用，暂存的到货应立即推出');
  assert.match(delivered[0], /王府井/);
});
await test('暂存的推送随状态落盘，重启后补发', async () => {
  const store = await new StateStore(join(dir, 'r-defer.json'), { flushDebounceMs: 5 }).init();
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://bark.restart/')) sent.push(JSON.parse(init.body).body);
    return { ok: true, status: 200 };
  };
  const n1 = new Notifier({ hub: new EventHub(), store, barkUrl: 'https://bark.restart/k', pushCooldownMs: 60_000, timeoutMs: 100 });
  n1.send(arrival('c1', '三里屯'));
  await new Promise(r => setTimeout(r, 50));
  n1.send(arrival('c2', '华贸购物中心'));
  assert.equal(store.loadOutbox().deferred.length, 1, '暂存的到货必须落盘');
  await store.close();
  clearTimeout(n1.flushTimer);

  const revived = await new StateStore(join(dir, 'r-defer.json')).init();
  const n2 = new Notifier({ hub: new EventHub(), store: revived, barkUrl: 'https://bark.restart/k', pushCooldownMs: 60_000, timeoutMs: 100 });
  n2.restore();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /华贸购物中心/);
  await revived.close();
});
await test('PUSH_ONLY_SKU：其它配置不推手机，但网页事件照常', async () => {
  let calls = 0;
  globalThis.fetch = async url => { if (String(url).startsWith('https://bark.only/')) calls += 1; return { ok: true, status: 200 }; };
  const hub = new EventHub();
  const seen = [];
  hub.add('s', { write: chunk => seen.push(chunk) });
  const notifier = new Notifier({ hub, barkUrl: 'https://bark.only/k', pushOnlySku: 'MJY74CH/A', timeoutMs: 100 });
  notifier.send(arrival('d1', '三里屯', { sku: 'MJY64CH/A' }));
  notifier.send(arrival('d2', '三里屯'));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal(seen.length, 2);
});

group('提速：节奏计时与限流处理（2026-10-25）');
await test('下一轮从上一轮开始算起：请求耗时不叠加到间隔上', () => {
  const { mon } = schedulerFixture();
  const plain = mon.nextDelay();
  assert.equal(plain.reason, 'steady-state');
  assert.equal(mon.afterRound(1_200).ms, plain.ms - 1_200);
  assert.equal(mon.afterRound(10 * 60_000).ms, 200, '慢轮之后也留最小间隔，不会空转');
});
await test('熔断等待与空闲等待不扣减（它们是绝对等待）', () => {
  const clock = fakeClock();
  const mon = new StockMonitor({
    inventory: { breaker: { state: 'open', retryAfterMs: () => 40_000 } },
    store: { allWatches: () => [{ id: 'w' }] }, catalog, intervalMs: 3_000, minIntervalMs: 3_000, now: clock.now
  });
  assert.equal(mon.afterRound(2_000).ms, mon.nextDelay().ms);
  assert.equal(mon.afterRound(2_000).reason, 'circuit-open');
});
await test('Apple 限流（541）不再打开熔断器，只放慢节奏', async () => {
  const clock = fakeClock();
  const inv = new InventoryService({
    catalog, now: clock.now, retries: 0,
    fetchImpl: async () => ({ ok: false, status: 541, headers: { get: () => null } })
  });
  for (let i = 0; i < 8; i += 1) {
    await assert.rejects(inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' }));
    clock.advance(3_000);
  }
  assert.equal(inv.counters.throttled, 8);
  assert.equal(inv.breaker.state, 'closed', '限流不是故障，不得停查');
});
await test('真故障（5xx）仍然打开熔断器', async () => {
  const clock = fakeClock();
  const inv = new InventoryService({
    catalog, now: clock.now, retries: 0,
    fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => null } })
  });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(inv.queryOne({ sku: 'MJY74CH/A', regionId: 'beijing' }));
    clock.advance(3_000);
  }
  assert.equal(inv.breaker.state, 'open');
});
await test('半开探针遇到限流会释放探针名额，熔断器不会卡死', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: clock.now });
  breaker.onFailure(new Error('x'));
  clock.advance(1_000);
  assert.equal(breaker.tryAcquire(), true);
  assert.equal(breaker.tryAcquire(), false, '探针名额已占用');
  breaker.onNeutral();
  assert.equal(breaker.tryAcquire(), true, '限流探针释放名额后可再探');
  assert.equal(breaker.state, 'half-open');
});
await test('被限流时健康检查报 upstream-throttled（降级，仍为 200）', () => {
  const verdict = assessHealth({
    inventory: { circuit: { state: 'closed' }, upstream: {} },
    monitor: { paused: false, stalled: false, lastError: null, failedRounds: 0, paceFactor: 4 },
    state: {}, stats: {}, notifications: {}
  });
  assert.equal(verdict.status, 'degraded');
  assert.equal(verdict.httpStatus, 200);
  assert.ok(verdict.warnings.includes('upstream-throttled'));
});

await rm(dir, { recursive: true, force: true });

// ---------------------------------------------------------------- done ---
console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${passed} 项通过, ${failures.length} 项失败\x1b[0m`);
if (failures.length) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error.stack}`);
  process.exit(1);
}
