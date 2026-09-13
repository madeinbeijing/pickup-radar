/**
 * Catalog verification / drift detection.
 *
 * The catalog is a hand-maintained snapshot of Apple's product data. Two risks follow:
 * a SKU could have been transcribed wrong (it would then resolve to `unknown` forever,
 * silently), and Apple can change prices, add finishes or move launch dates at any time.
 *
 * This re-derives the catalog from Apple's own pages and diffs it against what we ship,
 * then writes a timestamped, hashed snapshot under evidence/ so any claim about where a
 * part number came from can be re-checked later rather than taken on trust.
 *
 *   node verify-catalog.mjs           # verify, exit non-zero on drift
 *   node verify-catalog.mjs --write   # also refresh the evidence snapshot
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from './src/catalog.mjs';
import { fetchJson } from './src/upstream.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const write = process.argv.includes('--write');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const HEADERS = { accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9', 'user-agent': UA };

/** Buy-page URL for a product, derived from the catalog's own buyBase. */
function buyPageOf(product) {
  return product.buyBase.replace(/\/$/, '');
}

/** Colour ids differ in spelling between Apple's copy and our catalog; compare loosely. */
const slim = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Apple's product names mix ordinary spaces with NO-BREAK SPACE (U+00A0) — the live page
 * carries "iPhone\u00a018 Pro\u00a0Max 1TB Burgundy". Comparing raw strings silently
 * matches nothing, so every name is normalised before use.
 */
const normalizeSpaces = value => String(value).replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Apple embeds an analytics payload listing every buyable variant:
 *   {"partNumber":"MK2M4CH/A","price":{"fullPrice":15999.00},"name":"iPhone Duo 256GB Star White"}
 * That is the authoritative mapping of part number -> capacity + finish + price.
 */
function extractVariants(html, productName) {
  const rows = [];
  const re = /\{"sku":"[^"]*","partNumber":"([^"]+)","price":\{"fullPrice":([\d.]+)\},"category":"[^"]*","name":"([^"]+)"\}/g;
  const wanted = normalizeSpaces(productName);
  for (const match of html.matchAll(re)) {
    const [, partNumber, price, rawName] = match;
    const name = normalizeSpaces(rawName);
    if (!name.startsWith(wanted + ' ')) continue;               // "18 Pro" must not swallow "18 Pro Max"
    const tail = name.slice(wanted.length + 1);                 // "256GB Star White"
    const capacity = tail.match(/^(\d+(?:GB|TB))/i)?.[1];
    if (!capacity) continue;
    rows.push({ partNumber, price: Number(price), capacity, colorText: tail.slice(capacity.length).trim() });
  }
  return rows;
}

/** "10 月 16 日晚 8 点接受预购。10 月 23 日发售。" */
function extractDates(html) {
  const text = normalizeSpaces(html.replace(/&nbsp;/g, ' ').replace(/\\n/g, ' '));
  const preorder = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。]{0,12}接受预购/);
  const release = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日发售/);
  return {
    preorder: preorder ? `${preorder[1]}月${preorder[2]}日` : null,
    release: release ? `${release[1]}月${release[2]}日` : null
  };
}

const problems = [];
const snapshot = { verifiedAt: new Date().toISOString(), catalogVersion: catalog.meta.version, products: {} };

for (const [id, product] of Object.entries(catalog.products)) {
  const url = buyPageOf(product);
  process.stdout.write(`\n${product.name}\n  source: ${url}\n`);

  let html;
  try {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    html = await response.text();
  } catch (error) {
    console.error(`  FAIL  无法获取页面: ${error.message}`);
    console.error('  （网络失败或 Apple 限流。这不能解释为“目录有误”，请稍后重试。）');
    problems.push({ product: id, kind: 'fetch', detail: error.message });
    continue;
  }

  const live = extractVariants(html, product.name);
  const dates = extractDates(html);
  if (!live.length) {
    console.error('  FAIL  页面中未解析出任何变体 —— Apple 页面结构可能已变化');
    problems.push({ product: id, kind: 'no-variants' });
    continue;
  }

  // --- SKU 对账 ---
  const ours = new Map(Object.entries(product.variants).map(([key, v]) => [v.sku, { key, ...v }]));
  const theirs = new Map(live.map(row => [row.partNumber, row]));

  for (const [sku, mine] of ours) {
    const found = theirs.get(sku);
    if (!found) { problems.push({ product: id, kind: 'sku-missing-upstream', sku, detail: mine.key }); continue; }
    const [capacity, color] = mine.key.split(':');
    if (found.capacity.toUpperCase() !== capacity.toUpperCase()) {
      problems.push({ product: id, kind: 'capacity-mismatch', sku, ours: capacity, theirs: found.capacity });
    }
    if (found.price !== mine.price) {
      problems.push({ product: id, kind: 'price-drift', sku, ours: mine.price, theirs: found.price });
    }
  }
  for (const sku of theirs.keys()) {
    if (!ours.has(sku)) problems.push({ product: id, kind: 'sku-new-upstream', sku, detail: theirs.get(sku).colorText });
  }

  // --- 颜色一致性 ---
  // Our colour ids are internal (`glacier-blue`); Apple's marketing name is `Glacier`.
  // Demanding string equality is a false positive. What actually matters is that the
  // mapping is a clean bijection: every SKU we tag with one colour must resolve to the
  // same upstream finish, and two of our colours must never collide on one finish.
  // That still catches a genuinely swapped SKU while ignoring naming differences.
  const forward = new Map();   // ourColor -> Set(upstream finish)
  const reverse = new Map();   // upstream finish -> Set(ourColor)
  for (const [sku, mine] of ours) {
    const found = theirs.get(sku);
    if (!found) continue;
    const color = mine.key.split(':')[1];
    const finish = slim(found.colorText);
    if (!forward.has(color)) forward.set(color, new Set());
    forward.get(color).add(finish);
    if (!reverse.has(finish)) reverse.set(finish, new Set());
    reverse.get(finish).add(color);
  }
  const colorMap = {};
  for (const [color, finishes] of forward) {
    if (finishes.size > 1) {
      problems.push({ product: id, kind: 'color-inconsistent', ours: color, theirs: [...finishes] });
    }
    colorMap[color] = [...finishes][0] ?? null;
  }
  for (const [finish, colors] of reverse) {
    if (colors.size > 1) {
      problems.push({ product: id, kind: 'color-collision', theirs: finish, ours: [...colors] });
    }
  }

  // --- 发售日期对账 ---
  const fmt = iso => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日`; };
  if (dates.preorder && dates.preorder !== fmt(product.preorderAt)) {
    problems.push({ product: id, kind: 'preorder-drift', ours: fmt(product.preorderAt), theirs: dates.preorder });
  }
  if (dates.release && dates.release !== fmt(product.releaseAt)) {
    problems.push({ product: id, kind: 'release-drift', ours: fmt(product.releaseAt), theirs: dates.release });
  }

  const mine = problems.filter(p => p.product === id);
  console.log(`  variants: ${live.length} upstream / ${ours.size} in catalog`);
  console.log(`  dates:    预购 ${dates.preorder || '—'} · 发售 ${dates.release || '—'}`);
  console.log(`  result:   ${mine.length ? `${mine.length} 处差异` : '一致'}`);

  snapshot.products[id] = {
    source: url,
    colorMap,
    variants: live.sort((a, b) => a.partNumber.localeCompare(b.partNumber)),
    dates
  };
  await new Promise(r => setTimeout(r, 2000));   // be polite between page loads
}

// --- 证据快照 ---
const body = JSON.stringify(snapshot.products);
snapshot.sha256 = createHash('sha256').update(body).digest('hex');

if (write) {
  const dir = join(__dirname, 'evidence');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'catalog-snapshot.json');
  await writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log(`\n快照已写入 evidence/catalog-snapshot.json  sha256=${snapshot.sha256.slice(0, 16)}…`);
} else {
  console.log(`\n快照哈希 sha256=${snapshot.sha256.slice(0, 16)}…  （--write 可保存）`);
}

if (problems.length) {
  console.error(`\n发现 ${problems.length} 处差异:`);
  for (const p of problems) console.error('  ' + JSON.stringify(p));
  console.error('\n目录与 Apple 不一致。错误的 SKU 会让该配置永远返回 unknown —— 请先核对再上线。');
  process.exit(1);
}
console.log('\n目录与 Apple 当前数据一致。');
