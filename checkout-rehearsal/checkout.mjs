#!/usr/bin/env node
import { chromium } from 'playwright';
import { readFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { validatePlan, expectedLines, parseCny, assertReview } from './plan.mjs';
import { classifyStoreEntry } from './opening.mjs';

const profile = fileURLToPath(new URL('../.data/checkout-rehearsal/chrome-profile/', import.meta.url));
const secretFile = fileURLToPath(new URL('../.data/checkout-rehearsal/secrets.json', import.meta.url));
const defaultPlan = new URL('./plan.json', import.meta.url);
const bagUrl = 'https://www.apple.com.cn/shop/bag';
const accountUrl = 'https://secure6.www.apple.com.cn/shop/account/home';
const mode = process.argv[2];
const resumeBag = process.argv.includes('--resume-bag');
const exitOnReview = process.argv.includes('--exit-on-review');
const waitForOpen = process.argv.includes('--wait-for-open');
const pollFlag = process.argv.find(v => v.startsWith('--poll-ms='));
const openingPollMs = pollFlag ? Number(pollFlag.slice(10)) : 5000;
const openingWaitMs = 20 * 60 * 1000;
const planFlag = process.argv.find(v => v.startsWith('--plan='));
const t0 = performance.now();
let stage = '启动';
let limited = false;
let logFile;

function fail(message) { throw new Error(`${stage}：${message}`); }
function elapsed() { return Math.round(performance.now() - t0); }

async function checkpoint(page, name, details = {}) {
  stage = name;
  const url = new URL(page.url());
  const event = { stage: name, elapsedMs: elapsed(), path: url.pathname, ...details };
  await appendFile(logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  console.log(`${String(Math.ceil(event.elapsedMs / 1000)).padStart(3)} 秒  ${name}`);
}

function ensureApple(page) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !/(^|\.)apple\.com\.cn$/.test(url.hostname)) {
    fail(`页面离开 Apple 中国官网：${url.hostname}`);
  }
  if (limited) fail('Apple 返回 541 限流；已停止，未重试');
}

async function waitUntil(page, description, condition, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    ensureApple(page);
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  ensureApple(page);
  const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const state = classifyStoreEntry({ pathname: new URL(page.url()).pathname, text, ready: false });
  if (state === 'waiting') fail(`等待${description}时出现 Apple 开售引导页；已停止，未重复提交`);
  if (state === 'login') fail(`等待${description}时登录状态失效；已停止`);
  fail(`等待${description}超时；页面可能已改变`);
}

async function visible(page, locator, description, timeoutMs) {
  await waitUntil(page, description, () => locator.isVisible(), timeoutMs);
}

async function goto(page, url, { allowStoreWaiting = false } = {}) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (response?.status() === 541) limited = true;
  ensureApple(page);
  if (response && response.status() >= 400 && !(allowStoreWaiting && response.status() === 503)) {
    fail(`Apple 页面返回 HTTP ${response.status()}`);
  }
  return response?.status() ?? null;
}

async function waitForStoreEntry(page, url, ready, description, { productPage = false } = {}) {
  const started = performance.now();
  let attempts = 0;
  while (true) {
    stage = `进入${description}`;
    attempts++;
    const requestAt = performance.now();
    const status = await goto(page, url, { allowStoreWaiting: true });
    const settleUntil = performance.now() + 2000;
    while (performance.now() < settleUntil) {
      ensureApple(page);
      if (status !== 503 && await ready()) {
        if (attempts > 1) console.log(`${Math.ceil(elapsed() / 1000)} 秒  ${description}已开放（检查 ${attempts} 次）`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const state = classifyStoreEntry({
      pathname: new URL(page.url()).pathname, text, ready: false, productPage
    });
    if (state === 'login') fail('已跳转到登录页；请先在脚本专用浏览器完成登录');
    if (state !== 'waiting') fail(`${description}尚不可用，且不是已知的开售引导页；已停止（HTTP ${status ?? '未知'}）`);
    if (!waitForOpen) fail(`${description}仍显示开售引导页；可使用 --wait-for-open 限时等待`);
    if (performance.now() - started >= openingWaitMs) fail(`${description}等待开售超过 20 分钟；已停止`);
    if (attempts === 1 || attempts % 6 === 0) {
      console.log(`${Math.ceil(elapsed() / 1000)} 秒  ${description}仍是引导页，稍后再检查`);
    }
    const nextRequest = Math.max(requestAt + openingPollMs, performance.now() + 1000);
    while (performance.now() < nextRequest) {
      ensureApple(page);
      if (await ready()) return; // Some waiting pages update in place without a reload.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function choose(page, name, { labelFirst = false } = {}) {
  const radio = page.getByRole('radio', { name });
  await waitUntil(page, `选项 ${String(name)}`, () => radio.isEnabled(), 25000);
  if (!await radio.isChecked()) {
    const id = await radio.getAttribute('id');
    const label = id ? page.locator(`label[for=${JSON.stringify(id)}]`) : null;
    if (labelFirst && label && await label.count()) {
      try { await label.click({ timeout: 3500 }); }
      catch { ensureApple(page); await radio.check({ timeout: 5000 }); }
    } else {
      try { await radio.check({ timeout: 5000 }); }
      catch (error) {
        ensureApple(page);
        fail(`无法选择 ${String(name)}（${await page.title()}）：${error.name}`);
      }
    }
  }
  if (!await radio.isChecked()) fail(`选项未成功选中：${String(name)}`);
}

async function addOne(page, plan, capacity) {
  stage = `选购 ${capacity}`;
  const heading = page.getByRole('heading', { level: 1, name: `购买 ${plan.modelName}` });
  await waitForStoreEntry(page, plan.productUrl, async () =>
    await heading.isVisible() && await page.getByRole('radio', { name: plan.color }).isVisible(),
  '购买页面', { productPage: true });
  await choose(page, plan.color, { labelFirst: true });
  await choose(page, new RegExp(`^${capacity}\\b`), { labelFirst: true });
  await waitUntil(page, '所选机型标题', async () => {
    const title = (await page.title()).replace(/\s/g, ' ');
    return title.includes(plan.modelName) && title.includes(capacity) && title.includes(plan.color);
  }, 25000);
  await choose(page, '不折抵换购');
  await choose(page, '不加 AppleCare+ 服务计划');

  const title = (await page.title()).replace(/\s/g, ' ');
  if (!title.includes(plan.modelName) || !title.includes(capacity) || !title.includes(plan.color)) {
    fail(`选机结果不符：${title}`);
  }
  await checkpoint(page, `已选 ${capacity} ${plan.color}`);
  await page.getByRole('button', { name: '添加到购物袋', exact: true }).click();
  ensureApple(page);
  await visible(page, page.getByRole('button', { name: '查看购物袋' }), '查看购物袋按钮', 25000);
  await page.getByRole('button', { name: '查看购物袋' }).click();
  await visible(page, page.getByRole('heading', { name: /你的购物袋总计/ }), '购物袋金额');
  ensureApple(page);
  await checkpoint(page, `已加入 ${capacity}`);
}

async function assertEmptyBag(page) {
  stage = '检查空购物袋';
  const empty = page.getByRole('heading', { name: '你的购物袋中没有商品。' });
  const filled = page.getByRole('heading', { name: /你的购物袋总计/ });
  await waitForStoreEntry(page, bagUrl, () => empty.or(filled).first().isVisible(), '购物袋');
  if (!await empty.isVisible()) fail('购物袋已有商品；请自行核对并清空，或用 --resume-bag 核对现有两台');
  await checkpoint(page, '购物袋为空');
}

async function verifyBag(page, plan) {
  stage = '核对购物袋';
  if (new URL(page.url()).pathname !== '/shop/bag') {
    const filled = page.getByRole('heading', { name: /你的购物袋总计/ });
    await waitForStoreEntry(page, bagUrl, () => filled.isVisible(), '购物袋');
  }
  const expected = expectedLines(plan);
  for (const line of expected) {
    const heading = page.getByRole('heading', { level: 2, name: line.title, exact: true });
    await visible(page, heading, `购物袋商品 ${line.title}`);
    const item = page.getByRole('listitem').filter({ has: heading }).first();
    const quantity = item.getByRole('combobox', { name: '数量' });
    if (await quantity.inputValue() !== String(line.quantity)) {
      await quantity.selectOption(String(line.quantity));
    }
  }
  // This cart-level count also rejects accessories or unplanned items.
  const itemCount = await page.locator('ol.rs-bag-items > li.rs-bag-item').count();
  if (itemCount !== expected.length) fail(`购物袋有 ${itemCount} 个条目，预期 ${expected.length} 个`);
  const totalLabel = page.getByRole('heading', {
    name: new RegExp(`你的购物袋总计 RMB ${plan.expectedTotalCny.toLocaleString('en-US')}`)
  });
  await visible(page, totalLabel, '准确总价');
  const total = parseCny(await totalLabel.innerText());
  if (total !== plan.expectedTotalCny || total > plan.maxTotalCny) fail('购物袋金额与方案不符');
  for (const line of expected) {
    const item = page.getByRole('listitem').filter({
      has: page.getByRole('heading', { level: 2, name: line.title, exact: true })
    }).first();
    if (await item.getByRole('combobox', { name: '数量' }).inputValue() !== String(line.quantity)) {
      fail(`购物袋数量未保存：${line.title}`);
    }
  }
  await checkpoint(page, '购物袋数量与价格核对通过', { itemCount, totalCny: total });
}

async function fulfillment(page, plan) {
  stage = '结账取货';
  await page.getByRole('button', { name: '结账', exact: true }).first().click();
  ensureApple(page);
  await visible(page, page.getByRole('heading', { name: '你希望如何收到订单商品？' }),
    '订单选项（可能需先运行 npm run login）', 25000);
  await choose(page, '我要取货');
  await visible(page, page.getByRole('heading', { level: 2, name: '选择取货零售店：' }), '门店列表');
  let store;
  for (let pass = 0; pass < 2 && !store; pass++) {
    for (const candidate of plan.storeCandidates) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const radio = page.getByRole('radio', { name: new RegExp(`${escaped}.*(?<!不)可取货`) });
      if (await radio.count() && await radio.isEnabled()) { await radio.check(); store = candidate; break; }
    }
    if (!store && pass === 0) {
      const more = page.getByRole('button', { name: '显示更多取货地点' });
      if (await more.isVisible()) await more.click();
    }
  }
  if (!store) fail('优选门店当前没有明确可取货选项；未改为送货');
  await checkpoint(page, '已选北京门店自取', { store });
  await page.getByRole('button', { name: '继续填写取货详情' }).click();
  await visible(page, page.getByRole('heading', { name: '现在请填写你的取货信息。' }), '取货表单', 25000);
  return store;
}

async function readIdLast4() {
  const info = await stat(secretFile);
  if (info.mode & 0o077) fail('本机证件配置权限过宽；请设为仅当前用户可读');
  const { idLast4 } = JSON.parse(await readFile(secretFile, 'utf8'));
  if (typeof idLast4 !== 'string' || !/^[\dXx]{4}$/.test(idLast4)) fail('本机证件后四位配置无效');
  return idLast4;
}

async function contactAndPayment(page, plan) {
  stage = '取货联系人';
  for (const name of ['姓氏', '名字']) {
    if (!(await page.getByRole('textbox', { name, exact: true }).inputValue()).trim()) {
      fail(`账户未自动填写${name}；请在浏览器补齐`);
    }
  }
  await page.getByRole('textbox', { name: '政府颁发的身份证件号码的后四位' })
    .fill(await readIdLast4());
  await choose(page, '电子发票 - 个人');
  await checkpoint(page, '取货人和个人发票已核对');
  await page.getByRole('button', { name: '继续选择付款方式' }).click();
  await visible(page, page.getByRole('heading', { name: '你希望如何付款？' }),
    '付款选择（请核对邮箱、手机或短信验证）', 25000);
  await choose(page, plan.payment);
  await checkpoint(page, '已选付款方式', { payment: plan.payment });
}

async function review(page, plan, store) {
  stage = '订单检查';
  await page.getByRole('button', { name: '检查订单' }).click();
  await visible(page, page.getByRole('heading', { name: /准备下单了吗？/ }), '订单检查页', 25000);
  ensureApple(page);
  const lines = [];
  for (const expected of expectedLines(plan)) {
    const heading = page.getByRole('heading', { level: 2, name: expected.title, exact: true });
    const itemText = await heading.locator('xpath=ancestor::li[1]').innerText();
    const quantity = Number(itemText.match(/数量\s*(\d+)/)?.[1]);
    lines.push({ title: expected.title, quantity });
  }
  const mainText = await page.getByRole('main').innerText();
  const totals = [...mainText.matchAll(/总计\s*RMB\s*([\d,]+)/g)];
  const total = totals.length ? parseCny(`RMB ${totals.at(-1)[1]}`) : NaN;
  const reviewData = {
    lines, total,
    invoice: await page.getByText('电子发票 - 个人', { exact: true }).count() ? '电子发票 - 个人' : '',
    payment: await page.getByRole('img', { name: plan.payment }).count() ? plan.payment : '',
    finalButton: await page.getByRole('button', { name: '立即下单', exact: true }).isVisible()
  };
  assertReview(reviewData, plan);
  await checkpoint(page, '已停在“立即下单”前', { store, totalCny: total });
  console.log(`完成用时 ${elapsed()} 毫秒。没有创建订单或付款。`);
}

async function pause(message, action = '按回车关闭专用浏览器。') {
  if (!input.isTTY) return;
  const rl = createInterface({ input, output });
  try { await rl.question(`${message}${action}`); }
  finally { rl.close(); }
}

async function main() {
  if (!['login', 'run'].includes(mode)) {
    console.log('用法：npm run login；npm run run [-- --resume-bag] [-- --wait-for-open] [-- --poll-ms=5000] [-- --plan=/绝对路径/plan.json] [-- --exit-on-review]');
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(openingPollMs) || openingPollMs < 3000 || openingPollMs > 30000) {
    console.error('--poll-ms 必须是 3000 至 30000 的整数毫秒数');
    process.exitCode = 2;
    return;
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const logDir = fileURLToPath(new URL('../.data/checkout-rehearsal/runs/', import.meta.url));
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  logFile = `${logDir}${new Date().toISOString().replaceAll(':', '-')}.jsonl`;
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, locale: 'zh-CN', viewport: null,
    acceptDownloads: false
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('response', response => {
    if (response.status() === 541 && /(^|\.)apple\.com\.cn$/.test(new URL(response.url()).hostname)) limited = true;
  });
  try {
    if (mode === 'login') {
      const status = await goto(page, accountUrl);
      console.log(`Apple 账户页：HTTP ${status ?? '未知'}；${new URL(page.url()).pathname}`);
      console.log('请在这个专用 Chrome 窗口自行登录 Apple 账户。脚本不会读取密码或验证码。');
      await pause('登录完成后，', '按回车验证并保存专用浏览器登录状态。');
      await goto(page, accountUrl);
      if (new URL(page.url()).pathname !== '/shop/account/home') {
        fail('专用浏览器仍未进入账户主页；登录状态尚未保存');
      }
      console.log('专用浏览器登录状态已验证。');
      return;
    }
    const plan = validatePlan(JSON.parse(await readFile(planFlag ? planFlag.slice(7) : defaultPlan, 'utf8')));
    console.log(`预演：${plan.modelName} ${plan.capacities.join(' + ')} ${plan.color}；上限 RMB ${plan.maxTotalCny}`);
    if (resumeBag) await verifyBag(page, plan);
    else {
      await assertEmptyBag(page);
      for (const capacity of new Set(plan.capacities)) await addOne(page, plan, capacity);
      await verifyBag(page, plan);
    }
    const store = await fulfillment(page, plan);
    await contactAndPayment(page, plan);
    await review(page, plan, store);
    if (!exitOnReview) await pause('订单检查页已打开；请不要点击“立即下单”。');
  } catch (error) {
    process.exitCode = 1;
    console.error(`已停止：${error.message}`);
    console.error(input.isTTY
      ? '脚本没有“立即下单”操作。浏览器保持当前页面供检查。'
      : '脚本没有“立即下单”操作。非交互运行结束后浏览器将关闭。');
    await pause('');
  } finally {
    await context.close();
  }
}

await main();
