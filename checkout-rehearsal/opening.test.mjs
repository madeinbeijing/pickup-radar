import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStoreEntry } from './opening.mjs';

test('开售提示即使返回 HTTP 200，也不能当成购买页', () => {
  assert.equal(classifyStoreEntry({ pathname: '/shop/bag', text: '我们马上回来。', ready: false }), 'waiting');
  assert.equal(classifyStoreEntry({ pathname: '/shop/bag', text: "We can't wait either.", ready: false }), 'waiting');
  assert.equal(classifyStoreEntry({ pathname: '/shop/buy-iphone/iphone-duo',
    text: 'iPhone Duo 10 月 16 日晚 8 点接受预购。', ready: false, productPage: true }), 'waiting');
});

test('只有目标页面可用才能继续，登录页和未知页必须停下', () => {
  assert.equal(classifyStoreEntry({ pathname: '/shop/bag', text: '你的购物袋总计', ready: true }), 'ready');
  assert.equal(classifyStoreEntry({ pathname: '/shop/signIn/account', text: '', ready: false }), 'login');
  assert.equal(classifyStoreEntry({ pathname: '/shop/bag', text: '发生错误', ready: false }), 'unexpected');
});
