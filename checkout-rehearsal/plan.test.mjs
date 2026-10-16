import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, expectedLines, parseCny, assertReview } from './plan.mjs';

const base = {
  productUrl: 'https://www.apple.com.cn/shop/buy-iphone/iphone-17',
  modelName: 'iPhone 17', color: '黑色', capacities: ['256GB', '512GB'],
  storeCandidates: ['Apple 三里屯'], payment: '微信支付', expectedTotalCny: 15598, maxTotalCny: 16000
};

test('两种容量分别占一行，同容量合并为两台', () => {
  assert.deepEqual(expectedLines(validatePlan(base)).map(x => x.quantity), [1, 1]);
  assert.deepEqual(expectedLines(validatePlan({ ...base, capacities: ['256GB', '256GB'] })).map(x => x.quantity), [2]);
});

test('网址、数量、付款与金额上限不能绕过', () => {
  for (const change of [
    { productUrl: 'https://example.com/shop/buy-iphone/iphone-17' },
    { productUrl: 'https://www.apple.com.cn/shop/checkout?_s=Review' },
    { capacities: ['256GB'] }, { capacities: ['256GB', '512GB', '1TB'] },
    { payment: 'Apple Pay' }, { maxTotalCny: 0 }, { expectedTotalCny: 16001 }
  ]) assert.throws(() => validatePlan({ ...base, ...change }));
});

test('金额解析与订单不符时停止', () => {
  assert.equal(parseCny('你的购物袋总计 RMB 15,598，分期付款'), 15598);
  assert.throws(() => parseCny('金额待定'));
  const review = { lines: expectedLines(validatePlan(base)),
    invoice: '电子发票 - 个人', payment: '微信支付', total: 15598, finalButton: true };
  assert.doesNotThrow(() => assertReview(review, validatePlan(base)));
  assert.throws(() => assertReview({ ...review, total: 16001 }, validatePlan(base)));
  assert.throws(() => assertReview({ ...review, lines: [{ ...review.lines[0], quantity: 2 }] }, validatePlan(base)));
  assert.throws(() => assertReview({ ...review, finalButton: false }, validatePlan(base)));
});
