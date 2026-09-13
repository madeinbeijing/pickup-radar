import { RequestGuard } from '/request-guard.js';

const $ = selector => document.querySelector(selector);

const TZ = 'Asia/Shanghai';
const hmFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });
const todayKey = () => dayFmt.format(new Date());
const hourOf = iso => Number(hourFmt.format(new Date(iso))) % 24;
const hh = h => `${String(h).padStart(2, '0')}:00`;
const n = value => Number(value || 0).toLocaleString('zh-CN');
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PAGE = 50;
const CONFIGS_COLLAPSED = 6;

function minutes(ms) {
  if (ms == null) return '';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)} 分钟`;
  const rest = Math.round(m % 60);
  return rest ? `${Math.floor(m / 60)} 小时 ${rest} 分` : `${Math.floor(m / 60)} 小时`;
}

function dayLabel(key) {
  if (key === todayKey()) return '今天';
  if (key === dayFmt.format(new Date(Date.now() - 86_400_000))) return '昨天';
  const [, m, d] = key.split('-');
  return `${Number(m)} 月 ${Number(d)} 日`;
}

// ---- state (mirrored in the URL so a view can be shared or reloaded) --------
const params = new URLSearchParams(location.search);
const state = {
  day: params.get('day') || todayKey(),
  product: params.get('product') || null,
  type: params.get('type') || '',
  region: params.get('region') || '',
  sku: params.get('sku') || '',
  hour: params.has('hour') && params.get('hour') !== '' ? Number(params.get('hour')) : null,
  summary: null,
  rows: [],
  hourCounts: {},
  total: 0,
  nextBefore: null,
  allConfigs: false
};
const summaryGuard = new RequestGuard();
const recordsGuard = new RequestGuard();
const recordsKey = () => ({ day: state.day, product: state.product, type: state.type, region: state.region, sku: state.sku, hour: state.hour });

function syncUrl() {
  const q = new URLSearchParams();
  if (state.day !== todayKey()) q.set('day', state.day);
  if (state.product) q.set('product', state.product);
  if (state.type) q.set('type', state.type);
  if (state.region) q.set('region', state.region);
  if (state.sku) q.set('sku', state.sku);
  if (state.hour != null) q.set('hour', String(state.hour));
  history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
}

// ---- tooltip ------------------------------------------------------------------
const tip = $('#tip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add('on');
  const box = tip.getBoundingClientRect();
  let left = x - box.width / 2;
  let top = y - box.height - 12;
  left = Math.min(Math.max(8, left), innerWidth - box.width - 8);
  if (top < 8) top = y + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => tip.classList.remove('on');

// ---- loading ------------------------------------------------------------------
async function loadSummary({ silent = false } = {}) {
  const key = { day: state.day, product: state.product };
  const token = summaryGuard.begin(key);
  if (!silent) {
    $('#page').setAttribute('aria-busy', 'true');
    $('#refreshButton').classList.add('spinning');
  }
  try {
    const q = new URLSearchParams({ day: state.day });
    if (state.product) q.set('product', state.product);
    const response = await fetch(`/api/stats?${q}`, { cache: 'no-store', signal: token.signal });
    const data = await response.json();
    if (!summaryGuard.isCurrent(token, { day: state.day, product: state.product })) return;
    if (!response.ok || !data.ok) throw new Error(data.error || String(response.status));
    state.summary = data;
    state.product = data.product;
    // Drop drill-downs that do not exist for this day / product.
    if (state.sku && !data.configBySku[state.sku]) state.sku = '';
    if (state.region && !data.regionsSeen.includes(state.region)) state.region = '';
    syncUrl();
    renderAll();
    const quiet = !data.hasData || (data.totals.ups === 0 && data.totals.downs === 0);
    if (!quiet && !(silent && state.rows.length > PAGE)) await loadRecords({ reset: true });
  } catch (error) {
    if (RequestGuard.isAbort(error)) return;
    renderFailure();
  } finally {
    if (summaryGuard.owns(token)) {
      summaryGuard.settle(token);
      $('#page').setAttribute('aria-busy', 'false');
      setTimeout(() => $('#refreshButton').classList.remove('spinning'), 250);
    }
  }
}

async function loadRecords({ reset }) {
  const key = recordsKey();
  const token = recordsGuard.begin(key);
  const q = new URLSearchParams({ day: state.day, limit: String(PAGE) });
  for (const [k, v] of Object.entries(key)) if (k !== 'day' && v !== '' && v != null) q.set(k, String(v));
  if (!reset && state.nextBefore) q.set('before', state.nextBefore);
  try {
    const response = await fetch(`/api/stats/events?${q}`, { cache: 'no-store', signal: token.signal });
    const data = await response.json();
    if (!recordsGuard.isCurrent(token, recordsKey())) return;
    if (!response.ok || !data.ok) throw new Error(data.error || String(response.status));
    state.rows = reset ? data.rows : [...state.rows, ...data.rows];
    state.total = data.total;
    state.hourCounts = data.hourCounts || {};
    state.nextBefore = data.nextBefore;
    renderRecords();
  } catch (error) {
    if (RequestGuard.isAbort(error)) return;
    $('#records').innerHTML = '<div class="rec-empty">加载失败</div>';
    $('#recordsMore').hidden = true;
  } finally {
    recordsGuard.settle(token);
  }
}

// ---- rendering ------------------------------------------------------------------
function renderFailure() {
  $('#summary').hidden = true;
  $('#body').hidden = true;
  $('#quiet').hidden = false;
  $('#quietDot').className = 'beacon';
  $('#quietChecked').textContent = '';
  $('#quietTitle').textContent = '加载失败';
  $('#quietFacts').innerHTML = '';
  $('#quietAction').hidden = true;
}

const LIVE_MS = 3 * 60_000;       // a check this recent means monitoring is running
const STALE_MS = 10 * 60_000;     // older than this, offer to turn monitoring on

/** Nothing arrived: one calm status panel instead of a wall of zeros. */
function renderQuiet(data) {
  const isToday = state.day === todayKey();
  const last = data.lastObservedAt ? Date.parse(data.lastObservedAt) : null;
  const age = last == null ? Infinity : Date.now() - last;

  $('#quietDot').className = `beacon${isToday && age <= LIVE_MS ? ' live' : ''}`;
  $('#quietChecked').textContent = last == null ? '' : `最近检查 ${new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(last))}`;
  $('#quietTitle').textContent = !data.hasData
    ? (isToday ? '今天还没有检查' : '当天没有检查')
    : (isToday ? '今天还没有到货' : '当天没有到货');

  const facts = [];
  const { monitorRounds, pageQueries } = data.counters;
  if (monitorRounds + pageQueries) {
    facts.push(`<div><dt>刷新</dt><dd class="num">${n(monitorRounds + pageQueries)}<small>自动 ${n(monitorRounds)} · 手动 ${n(pageQueries)}</small></dd></div>`);
  }
  const cov = data.coverage;
  if (isToday && cov && cov.stores) {
    facts.push(`<div><dt>覆盖</dt><dd class="num">${n(cov.stores)}<small>家店 · ${n(cov.regions)} 个城市 · ${n(cov.configs)} 个配置</small></dd></div>`);
  }
  if (data.lastArrival) {
    const a = data.lastArrival;
    const when = `${a.day === todayKey() ? '' : `${dayLabel(a.day)} `}${hmFmt.format(new Date(a.t))}`;
    facts.push(`<div><dt>上次到货</dt><dd><button type="button" class="jump" data-day="${a.day}" data-sku="${esc(a.sku)}" data-hour="${hourOf(a.t)}">${esc(when)}<small>${esc(a.capacity)} ${esc(a.colorLabel)} · ${esc(a.storeName)}</small></button></dd></div>`);
  }
  $('#quietFacts').innerHTML = facts.join('');
  $('#quietAction').hidden = !(isToday && age > STALE_MS);
}

function renderAll() {
  const data = state.summary;
  renderDays(data);
  renderProducts(data);
  const quiet = !data.hasData || (data.totals.ups === 0 && data.totals.downs === 0);
  $('#quiet').hidden = !quiet;
  $('#summary').hidden = quiet;
  $('#body').hidden = quiet;
  if (quiet) return renderQuiet(data);
  renderSummary(data);
  renderChart(data);
  renderConfigs(data);
  renderRegions(data);
  renderTypeSeg();
}

function renderDays(data) {
  const days = [...new Set([todayKey(), state.day, ...data.days])].sort().reverse();
  $('#days').hidden = days.length < 2;   // a single "today" chip is not a choice
  $('#days').innerHTML = days.map(key =>
    `<button type="button" class="day" data-day="${key}" aria-current="${key === state.day}">${dayLabel(key)}</button>`
  ).join('');
}

function renderProducts(data) {
  const ids = [...new Set([data.product, ...data.products])].filter(id => data.productNames[id]);
  const seg = $('#productSeg');
  seg.hidden = ids.length < 2;
  seg.innerHTML = ids.map(id =>
    `<button type="button" role="radio" data-product="${id}" class="${id === data.product ? 'active' : ''}" aria-checked="${id === data.product}">${esc(data.productNames[id])}</button>`
  ).join('');
}

function renderSummary(data) {
  const { counters, totals } = data;
  const isToday = state.day === todayKey();
  const metric = (label, big, unit, sub, cls = '') =>
    `<dl class="metric"><dt>${label}</dt><dd class="big num ${cls}">${big}${unit ? `<small>${unit}</small>` : ''}</dd><dd class="sub">${sub}</dd></dl>`;
  $('#summary').innerHTML = [
    metric('刷新', n(counters.monitorRounds + counters.pageQueries), '次', `自动 ${n(counters.monitorRounds)} · 手动 ${n(counters.pageQueries)}`),
    metric('到货', n(totals.ups), '次', totals.stores ? `${n(totals.stores)} 家店` : '&nbsp;', totals.ups ? 'good' : ''),
    metric('售罄', n(totals.downs), '次', totals.avgDurationMin == null ? '&nbsp;' : `平均有货 ${Math.round(totals.avgDurationMin)} 分钟`),
    metric(isToday ? '现在有货' : '结束时有货', n(totals.storesAvailableNow), '家', '&nbsp;', totals.storesAvailableNow ? 'good' : '')
  ].join('');
}

/** Axis step for whole-number counts: never fractional, at most ~4 gridlines. */
function niceStep(max) {
  const raw = Math.max(1, max / 4);
  const pow = 10 ** Math.floor(Math.log10(raw));
  return Math.max(1, [1, 2, 5, 10].map(m => m * pow).find(s => s >= raw));
}

/** Column with rounded top corners and a flat base on the axis. */
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function renderChart(data) {
  const { from, to } = data.hourRange;
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const ups = state.sku ? (data.hourlyUpBySku[state.sku] || Array(24).fill(0)) : data.hourly.map(h => h.up);
  const values = hours.map(h => ups[h]);
  $('#chartScope').textContent = state.sku ? data.configBySku[state.sku]?.name || '' : '';

  const W = 960, H = 220, ml = 34, mr = 6, mt = 20, mb = 28;
  const plotW = W - ml - mr, plotH = H - mt - mb;
  const peak = Math.max(0, ...values);
  const step = niceStep(peak);
  const yMax = Math.max(step, Math.ceil(peak / step) * step);
  const y = v => mt + plotH * (1 - v / yMax);
  const colW = plotW / hours.length;
  const barW = Math.max(4, Math.min(32, colW * 0.58));
  const labelEvery = hours.length <= 12 ? 1 : hours.length <= 18 ? 2 : 3;

  let svg = '';
  for (let v = 0; v <= yMax; v += step) {
    svg += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--axis-line)' : 'var(--grid-line)'}" stroke-width="1"/>`;
    svg += `<text x="${ml - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  hours.forEach((h, i) => {
    const cx = ml + colW * i + colW / 2;
    const v = values[i];
    const picked = state.hour === h;
    svg += `<g class="col${picked ? ' picked' : ''}" data-hour="${h}" role="button" tabindex="0" aria-pressed="${picked}" aria-label="${hh(h)}，到货 ${v} 次">
      <rect class="hit" x="${ml + colW * i + 1}" y="${mt - 14}" width="${Math.max(1, colW - 2)}" height="${plotH + 14}" rx="6"/>
      <path class="bar" d="${barPath(cx - barW / 2, y(v), barW, y(0) - y(v), 4)}"/>
      ${picked && v ? `<text class="val" x="${cx}" y="${y(v) - 6}" text-anchor="middle">${v}</text>` : ''}
    </g>`;
    if ((h - from) % labelEvery === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${hh(h)}</text>`;
  });

  const host = $('#chart');
  host.classList.toggle('has-pick', state.hour != null);
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="每小时到货">${svg}</svg>`;
}

function renderConfigs(data) {
  const rows = data.ranking;
  const list = $('#configs');
  $('#configCount').textContent = rows.length ? String(rows.length) : '';
  if (!rows.length) {
    list.innerHTML = '<li class="rec-empty">无到货</li>';
    $('#configsMore').hidden = true;
    return;
  }
  const top = rows[0].ups;
  // Keep the selected config visible even when the list is collapsed.
  let shown = state.allConfigs ? rows : rows.slice(0, CONFIGS_COLLAPSED);
  if (state.sku && !shown.some(r => r.sku === state.sku)) {
    const picked = rows.find(r => r.sku === state.sku);
    if (picked) shown = [...shown, picked];
  }
  list.innerHTML = shown.map(r => {
    const meta = [`${r.stores} 家店`, r.avgDurationMin == null ? '' : `平均 ${Math.round(r.avgDurationMin)} 分钟`].filter(Boolean).join(' · ');
    return `<li><button type="button" class="cfg" data-sku="${esc(r.sku)}" aria-pressed="${r.sku === state.sku}">
      <span class="dot" style="background:${esc(r.swatch || 'var(--fill-strong)')}"></span>
      <span class="cfg-name">${esc(r.capacity)} ${esc(r.colorLabel)}</span>
      <span class="cfg-count num">${r.ups}</span>
      <span class="cfg-track"><i style="width:${Math.max(3, r.ups / top * 100)}%"></i></span>
      <span class="cfg-meta">${meta}</span>
    </button></li>`;
  }).join('');
  const more = $('#configsMore');
  more.hidden = rows.length <= CONFIGS_COLLAPSED;
  more.textContent = state.allConfigs ? '收起' : `全部 ${rows.length} 个`;
}

function renderRegions(data) {
  const host = $('#regions');
  if (data.regionsSeen.length < 2) { host.innerHTML = ''; return; }
  const options = [['', '全部城市'], ...data.regionsSeen.map(id => [id, data.regions[id] || id])];
  host.innerHTML = options.map(([id, label]) =>
    `<button type="button" class="pill" data-region="${id}" aria-pressed="${state.region === id}">${esc(label)}</button>`
  ).join('');
}

function renderTypeSeg() {
  document.querySelectorAll('#typeSeg button').forEach(button => {
    const on = button.dataset.type === state.type;
    button.classList.toggle('active', on);
    button.setAttribute('aria-checked', String(on));
  });
}

const xIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';

function renderRecords() {
  const data = state.summary;
  const chips = [];
  if (state.sku) {
    const name = data.configBySku[state.sku]?.name || state.sku;
    chips.push(`<button type="button" class="chip-x" data-clear="sku" aria-label="取消 ${esc(name)}">${esc(name)}${xIcon}</button>`);
  }
  if (state.hour != null) chips.push(`<button type="button" class="chip-x" data-clear="hour" aria-label="取消 ${hh(state.hour)}">${hh(state.hour)}${xIcon}</button>`);
  $('#activeFilters').innerHTML = chips.join('');
  $('#recordCount').textContent = state.total ? n(state.total) : '';

  if (!state.rows.length) {
    $('#records').innerHTML = '<div class="rec-empty">无记录</div>';
    $('#recordsMore').hidden = true;
    return;
  }

  const isToday = state.day === todayKey();
  let html = '';
  let hour = null;
  for (const row of state.rows) {
    const h = hourOf(row.t);
    if (h !== hour) {
      hour = h;
      const c = state.hourCounts[h] || { up: 0, down: 0 };
      html += `<div class="rec-hour"><b class="num">${hh(h)}</b><span class="num">到货 ${c.up} · 售罄 ${c.down}</span></div>`;
    }
    const config = data.configBySku[row.sku] || {};
    const place = `${esc(row.storeName)} · ${esc(data.regions[row.region] || row.region || '')}`;
    const span = row.type === 'up' && row.windowMs == null
      ? `<span class="live">${isToday ? '仍有货' : '有货至结束'}</span>`
      : `有货 ${row.uncertain ? '约 ' : ''}${minutes(row.windowMs)}`;
    html += `<article class="rec">
      <time class="num" datetime="${row.t}">${hmFmt.format(new Date(row.t))}</time>
      <div class="rec-title"><span class="dot" style="background:${esc(config.swatch || 'var(--fill-strong)')}"></span><span>${esc(config.name || `${row.capacity} ${row.colorLabel}`)}</span></div>
      <span class="rec-tag ${row.type}">${row.type === 'up' ? '到货' : '售罄'}</span>
      <div class="rec-sub">${place} · ${span}</div>
    </article>`;
  }
  $('#records').innerHTML = html;
  $('#recordsMore').hidden = !state.nextBefore;
}

// ---- interactions -----------------------------------------------------------------
function update(patch, { summary = false } = {}) {
  Object.assign(state, patch);
  syncUrl();
  if (summary) return loadSummary();
  renderChart(state.summary);
  renderConfigs(state.summary);
  renderRegions(state.summary);
  renderTypeSeg();
  return loadRecords({ reset: true });
}

$('#days').addEventListener('click', event => {
  const button = event.target.closest('.day');
  if (!button || button.dataset.day === state.day) return;
  update({ day: button.dataset.day, product: null, sku: '', hour: null, region: '' }, { summary: true });
});

$('#productSeg').addEventListener('click', event => {
  const button = event.target.closest('button[data-product]');
  if (!button || button.dataset.product === state.product) return;
  update({ product: button.dataset.product, sku: '', hour: null, region: '' }, { summary: true });
});

$('#configs').addEventListener('click', event => {
  const button = event.target.closest('.cfg');
  if (!button) return;
  update({ sku: state.sku === button.dataset.sku ? '' : button.dataset.sku });
});

$('#configsMore').addEventListener('click', () => {
  state.allConfigs = !state.allConfigs;
  renderConfigs(state.summary);
});

function pickHour(target) {
  const col = target.closest?.('.col');
  if (!col) return;
  hideTip();
  const h = Number(col.dataset.hour);
  update({ hour: state.hour === h ? null : h });
}
$('#chart').addEventListener('click', event => pickHour(event.target));
$('#chart').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  pickHour(event.target);
});
$('#chart').addEventListener('pointermove', event => {
  const col = event.target.closest?.('.col');
  if (!col) return hideTip();
  const h = Number(col.dataset.hour);
  const data = state.summary;
  const body = state.sku
    ? `到货 ${(data.hourlyUpBySku[state.sku] || [])[h] || 0}`
    : `到货 ${data.hourly[h].up} · 售罄 ${data.hourly[h].down}`;
  showTip(`<div class="t">${hh(h)}–${hh((h + 1) % 24)}</div><div class="num">${body}</div>`, event.clientX, event.clientY);
});
$('#chart').addEventListener('pointerleave', hideTip);

$('#typeSeg').addEventListener('click', event => {
  const button = event.target.closest('button[data-type]');
  if (!button || button.dataset.type === state.type) return;
  update({ type: button.dataset.type });
});

$('#regions').addEventListener('click', event => {
  const button = event.target.closest('.pill');
  if (!button || button.dataset.region === state.region) return;
  update({ region: button.dataset.region });
});

$('#activeFilters').addEventListener('click', event => {
  const button = event.target.closest('[data-clear]');
  if (!button) return;
  update(button.dataset.clear === 'sku' ? { sku: '' } : { hour: null });
});

$('#recordsMore').addEventListener('click', () => loadRecords({ reset: false }));

// Jump from the quiet panel straight to the most recent arrival.
$('#quietFacts').addEventListener('click', event => {
  const button = event.target.closest('.jump');
  if (!button) return;
  update({ day: button.dataset.day, sku: button.dataset.sku, hour: Number(button.dataset.hour), type: '', region: '' }, { summary: true });
});
$('#refreshButton').addEventListener('click', () => loadSummary());

setInterval(() => {
  if (document.visibilityState === 'visible' && state.day === todayKey()) loadSummary({ silent: true });
}, 60_000);

loadSummary();
