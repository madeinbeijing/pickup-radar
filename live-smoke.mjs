import { catalog, getRegion, getVariant, getProduct, launchPhase } from './src/catalog.mjs';
import { InventoryService } from './src/inventory.mjs';
import { CoveragePlanner } from './src/coverage.mjs';

const productId = process.argv[2] || catalog.defaultProduct;
const product = getProduct(productId);
const capacity = process.argv[3] || product?.capacities[0];
const color = process.argv[4] || product?.colors[0]?.id;
const regionId = process.argv[5] || 'beijing';
const variant = getVariant(productId, capacity, color);
const regionInfo = getRegion(regionId);

if (!product || !variant || !regionInfo) {
  console.error('Usage: node live-smoke.mjs [product] [capacity] [color] [region]');
  console.error(`  products: ${Object.keys(catalog.products).join(', ')}`);
  if (product) {
    console.error(`  ${product.id} capacities: ${product.capacities.join(', ')}`);
    console.error(`  ${product.id} colors: ${product.colors.map(c => c.id).join(', ')}`);
  }
  process.exit(2);
}

const planner = new CoveragePlanner({ catalog });
const inventory = new InventoryService({ catalog, planner, freshTtlMs: 0, staleTtlMs: 0, timeoutMs: 10_000 });

console.log(`Pickup Radar ${catalog.meta.version} live contract smoke`);
console.log(`Target: ${product.name} · ${capacity} · ${color} · ${regionInfo.label}`);
console.log(`Phase: ${launchPhase(productId)}`);
console.log(`SKU: ${variant.sku}`);
console.log('Endpoint: https://www.apple.com.cn/shop/retail/pickup-message\n');

try {
  const result = await inventory.queryOne({ sku: variant.sku, regionId });
  const counts = result.stores.reduce((acc, store) => {
    acc[store.status] = (acc[store.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`OK  HTTP/schema contract succeeded at ${result.fetchedAt}`);
  console.log(`OK  Parsed ${result.stores.length} stores; catalog expects ${regionInfo.stores.length}`);
  console.log(`OK  Status counts: ${JSON.stringify(counts)}`);
  for (const store of result.stores) {
    const flag = store.missingFromResponse ? '  [missing-from-response]' : '';
    console.log(`    ${(store.id || '-').padEnd(5)} Apple ${store.name}: ${store.status}${flag}`);
  }

  // Coverage is the v2 contract: one anchored request must resolve the whole city.
  const resolved = result.stores.filter(s => !s.missingFromResponse).length;
  const coverage = Math.round((resolved / result.stores.length) * 100);
  console.log(`\nCoverage: ${resolved}/${result.stores.length} stores resolved in one request (${coverage}%)`);
  const spill = planner.coverageOf(regionInfo.seedStore);
  if (spill && spill.size > 1) {
    console.log(`Harvest:  the same request also fully covered ${[...spill].filter(r => r !== regionId).join(', ')}`);
  }

  const unknown = counts.unknown || 0;
  if (unknown) {
    console.warn(`\n!  ${unknown} store(s) are unknown. This is NOT "out of stock" - investigate before relying on it.`);
    process.exitCode = 3;
  }
} catch (error) {
  console.error(`FAIL  Live contract failed: ${error?.code || error?.message || error}`);
  console.error('Do NOT interpret this as out of stock. The upstream contract/network must be investigated.');
  process.exit(1);
}
