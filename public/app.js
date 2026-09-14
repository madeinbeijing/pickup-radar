import { RequestGuard, sameSelection } from '/request-guard.js';
import { deviceArt } from '/device-art.js';

const query = new URLSearchParams(location.search);
const state = {
  catalog: null,
  phases: {},
  product: localStorage.getItem('pickup.product') || '',
  capacity: localStorage.getItem('pickup.capacity') || '256GB',
  color: localStorage.getItem('pickup.color') || 'silver',
  region: localStorage.getItem('pickup.region') || 'beijing',
  filter: 'all',
  stores: [],
  // loading | ready | gate | error — drives the summary card, list and mobile bar together.
  status: 'loading',
  renderedSelection: null,
  watches: [],
  loading: false,
  watchLoading: false,
  demo: query.get('demo') === '1',
  autoRefresh: localStorage.getItem('pickup.autoRefresh') !== '0',
  sound: localStorage.getItem('pickup.sound') !== '0',
  lastResult: null,
  timer: null,
  phaseTimer: null,
  eventSource: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const els = {
  sourceButton: $('#sourceButton'), sourceText: $('#sourceText'), refreshButton: $('#refreshButton'),
  productOptions: $('#productOptions'), productName: $('#productName'), productSubtitle: $('#productSubtitle'),
  capacityOptions: $('#capacityOptions'), colorOptions: $('#colorOptions'), colorName: $('#colorName'),
  priceLabel: $('#priceLabel'), skuLabel: $('#skuLabel'), deviceArt: $('#deviceArt'),
  regionButton: $('#regionButton'), regionLabel: $('#regionLabel'), regionMeta: $('#regionMeta'),
  locationButton: $('#locationButton'), selectionSummary: $('#selectionSummary'), appleProductLink: $('#appleProductLink'),
  watchCard: $('#watchCard'), watchTitle: $('#watchTitle'), watchMeta: $('#watchMeta'), watchButton: $('#watchButton'),
  summaryCard: $('#summaryCard'), summaryTitle: $('#summaryTitle'), resultsRegionLabel: $('#resultsRegionLabel'),
  phaseCopy: $('#phaseCopy'), phaseBanner: $('#phaseBanner'), phaseTitle: $('#phaseTitle'),
  phaseCountdownLabel: $('#phaseCountdownLabel'), countdown: $('#countdown'),
  distBar: $('#distBar'), availableCount: $('#availableCount'), unavailableCount: $('#unavailableCount'),
  unknownCount: $('#unknownCount'), updatedTime: $('#updatedTime'), freshness: $('#freshness'),
  allTabCount: $('#allTabCount'), availableTabCount: $('#availableTabCount'),
  storeList: $('#storeList'), autoRefresh: $('#autoRefresh'), soundAlert: $('#soundAlert'), demoButton: $('#demoButton'),
  regionModal: $('#regionModal'), regionSearch: $('#regionSearch'), regionList: $('#regionList'), cityCount: $('#cityCount'), storeCount: $('#storeCount'),
  mobileDot: $('#mobileDot'), mobileRegion: $('#mobileRegion'), mobileSelection: $('#mobileSelection'), mobileRefresh: $('#mobileRefresh'),
  toast: $('#toast')
};

const icons = {
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M7 12h10"/></svg>',
  question: '<svg viewBox="0 0 24 24"><path d="M9.2 9a2.9 2.9 0 1 1 4.1 2.6c-.8.4-1.3 1.1-1.3 2v.4"/><path d="M12 17.6h.01"/></svg>',
  slash: '<svg viewBox="0 0 24 24"><path d="M7.5 16.5l9-9"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4M12 16.8h.01"/></svg>',
  store: '<svg viewBox="0 0 24 24"><path d="M4 9.5 5.5 4h13L20 9.5M4 9.5h16M4 9.5V20h16V9.5"/><path d="M9.5 20v-5h5v5"/></svg>',
  checkBold: '<svg class="check" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7"/></svg>'
};

const money = value => new Intl.NumberFormat('zh-CN').format(value);
const currentProduct = () => state.catalog.products[state.product] || state.catalog.products[state.catalog.defaultProduct];
const currentVariant = () => currentProduct()?.variants[`${state.capacity}:${state.color}`];
const currentColor = () => currentProduct()?.colors.find(item => item.id === state.color);
const currentRegion = () => state.catalog.regions[state.region];
const currentWatch = () => state.watches.find(w => w.sku === currentVariant()?.sku && w.region === state.region) || null;

function persist() {
  localStorage.setItem('pickup.product', state.product);
  localStorage.setItem('pickup.capacity', state.capacity);
  localStorage.setItem('pickup.color', state.color);
  localStorage.setItem('pickup.region', state.region);
  localStorage.setItem('pickup.autoRefresh', state.autoRefresh ? '1' : '0');
  localStorage.setItem('pickup.sound', state.sound ? '1' : '0');
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function sourceState(kind, text) {
  els.sourceButton.className = `source-pill ${kind}`;
  els.sourceText.textContent = text;
}

function appleUrl() {
  const variant = currentVariant();
  if (!variant) return currentProduct()?.buyBase || '#';
  return `${currentProduct().buyBase}${variant.slug}`;
}

function phase(productId) {
  const product = productId ? state.catalog.products[productId] : currentProduct();
  if (!product) return 'released';
  const now = Date.now();
  if (now < new Date(product.preorderAt).getTime()) return 'prelaunch';
  if (now < new Date(product.releaseAt).getTime()) return 'preorder';
  return 'released';
}

/** "10 月 16 日 20:00" style label, derived from the product rather than hardcoded. */
function dateLabel(iso, withTime = false) {
  const d = new Date(iso);
  const base = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  if (!withTime) return base;
  const h = d.getHours();
  return `${base}${h === 0 ? '' : ` ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}`;
}

function formatDuration(ms) {
  if (ms <= 0) return '已到时间';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const hms = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return days > 0 ? `${days} 天 ${hms}` : hms;
}

function relativeCheck(iso) {
  if (!iso) return '等待首次成功检查';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前检查`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} 分钟前检查`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

// ---- phase -----------------------------------------------------------------

function renderPhase() {
  const p = phase();
  const product = currentProduct();
  if (!product) return;
  const now = Date.now();
  els.phaseBanner.className = `countdown ${p}`;
  els.phaseCopy.parentElement.className = `phase-line ${p}`;

  if (p === 'prelaunch') {
    els.phaseCopy.textContent = `${dateLabel(product.preorderAt, true)} 开始预购`;
    els.phaseCountdownLabel.textContent = '距预购开放';
    els.countdown.textContent = formatDuration(new Date(product.preorderAt).getTime() - now);
    els.phaseTitle.textContent = `${dateLabel(product.releaseAt)}发售`;
  } else if (p === 'preorder') {
    els.phaseCopy.textContent = `预购进行中 · ${dateLabel(product.releaseAt)}发售`;
    els.phaseCountdownLabel.textContent = '距正式发售';
    els.countdown.textContent = formatDuration(new Date(product.releaseAt).getTime() - now);
    els.phaseTitle.textContent = dateLabel(product.releaseAt, true);
  } else {
    els.phaseCopy.textContent = '现已发售';
    els.phaseCountdownLabel.textContent = '状态';
    els.countdown.textContent = '已发售';
    els.phaseTitle.textContent = '';
  }
  renderWatch();
}

// ---- configuration -----------------------------------------------------------

function renderControls() {
  const region = currentRegion();
  const color = currentColor();
  const variant = currentVariant();
  const product = currentProduct();

  els.productName.textContent = product.name;
  els.productSubtitle.textContent = product.subtitle || '';
  els.productOptions.innerHTML = Object.values(state.catalog.products).map(item => {
    const ph = phase(item.id);
    const tag = ph === 'prelaunch' ? `${dateLabel(item.preorderAt)}预购` : ph === 'preorder' ? '预购中' : '已发售';
    const active = item.id === product.id;
    return `<button class="${active ? 'active' : ''}" type="button" data-product="${item.id}" role="radio" aria-checked="${active}">
      <strong>${escapeHtml(item.name)}</strong><small class="${ph === 'prelaunch' ? '' : 'live'}">${tag}</small></button>`;
  }).join('');

  els.capacityOptions.innerHTML = product.capacities.map(capacity => {
    const priced = product.variants[`${capacity}:${state.color}`] || Object.entries(product.variants).find(([key]) => key.startsWith(`${capacity}:`))?.[1];
    const active = capacity === state.capacity;
    return `<button class="cap ${active ? 'active' : ''}" type="button" data-capacity="${capacity}" role="radio" aria-checked="${active}">
      <strong>${capacity}</strong><small>${priced ? `¥${money(priced.price)}` : ''}</small></button>`;
  }).join('');

  els.colorOptions.innerHTML = product.colors.map(item => {
    const active = item.id === state.color;
    return `<button class="swatch ${active ? 'active' : ''}" type="button" data-color="${item.id}" role="radio" aria-checked="${active}"
      aria-label="${escapeHtml(item.label)}" title="${escapeHtml(item.label)}" style="--swatch:${item.swatch}"></button>`;
  }).join('');

  els.colorName.textContent = color.label;
  els.priceLabel.textContent = `¥${money(variant.price)}`;
  els.skuLabel.textContent = variant.sku;
  const artKey = `${product.id}:${state.color}`;
  if (els.deviceArt.dataset.key !== artKey) {
    els.deviceArt.dataset.key = artKey;
    els.deviceArt.innerHTML = deviceArt(product.id, state.color, 204);
    els.deviceArt.classList.remove('swap');
    void els.deviceArt.offsetWidth; // restart the entrance animation
    els.deviceArt.classList.add('swap');
  }
  els.deviceArt.parentElement.style.setProperty('--device-glow', color.swatch);
  els.regionLabel.textContent = region.label;
  els.regionMeta.textContent = `${region.stores.length} 家 Apple Store`;
  els.resultsRegionLabel.textContent = `${region.label} · ${region.stores.length} 家 Apple Store`;
  els.appleProductLink.href = appleUrl();
  renderSummary();
  renderWatch();
}

function selectProduct(id) {
  if (id === state.product || !state.catalog.products[id]) return;
  state.product = id;
  // Capacities and colors are per-product; snap the selection onto the new product's
  // options so a Duo colour is never carried over to an 18 Pro Max query.
  const next = currentProduct();
  if (!next.capacities.includes(state.capacity)) state.capacity = next.capacities[0];
  if (!next.colors.some(c => c.id === state.color)) state.color = next.colors[0].id;
  persist(); renderControls(); renderPhase(); refresh();
}

// ---- watch -----------------------------------------------------------------

function renderWatch() {
  if (!state.catalog || !els.watchCard) return;
  const watch = currentWatch();
  // A pre-launch product can still be armed: the monitor skips it until its window
  // opens, so arming early costs nothing and is exactly what a user wants beforehand.
  const blocked = state.demo;
  els.watchCard.classList.toggle('active', Boolean(watch));
  els.watchCard.classList.toggle('disabled', blocked && !watch);
  els.watchButton.disabled = state.watchLoading || (blocked && !watch);
  els.watchButton.className = `btn ${watch ? 'btn-secondary' : 'btn-primary'}`;

  if (state.watchLoading) {
    els.watchButton.textContent = '处理中…';
    return;
  }

  if (watch) {
    const armed = phase() === 'prelaunch';
    els.watchTitle.textContent = armed ? '已布控 · 等待预购开放' : '正在监控此配置';
    els.watchMeta.textContent = armed
      ? dateLabel(currentProduct().preorderAt, true)
      : relativeCheck(watch.lastCheckedAt);
    els.watchButton.textContent = armed ? '取消布控' : '停止';
    return;
  }

  if (state.demo) {
    els.watchTitle.textContent = '到货监控';
    els.watchMeta.textContent = '';
    els.watchButton.textContent = '不可用';
    return;
  }
  if (phase() === 'prelaunch') {
    els.watchTitle.textContent = '提前布控';
    els.watchMeta.textContent = dateLabel(currentProduct().preorderAt, true);
    els.watchButton.textContent = '提前布控';
    return;
  }

  els.watchTitle.textContent = '到货监控';
  els.watchMeta.textContent = '';
  els.watchButton.textContent = '开启监控';
}

// ---- results ---------------------------------------------------------------

function statusMeta(status) {
  if (status === 'available') return { label: '可取货', detail: '可到店取货', className: 'available', icon: icons.check, rank: 0 };
  if (status === 'unavailable') return { label: '无货', detail: '暂不可取货', className: 'unavailable', icon: icons.minus, rank: 3 };
  if (status === 'ineligible') return { label: '不可取货', detail: '此配置暂不支持', className: 'ineligible', icon: icons.slash, rank: 2 };
  return { label: '未确认', detail: '查询结果不完整', className: 'unknown', icon: icons.question, rank: 1 };
}

function counts() {
  const by = status => state.stores.filter(store => store.status === status).length;
  const available = by('available');
  const unknown = by('unknown');
  return { total: state.stores.length, available, unknown, unavailable: state.stores.length - available - unknown };
}

function renderSummary() {
  if (!state.catalog) return;
  const product = currentProduct();
  const region = currentRegion();
  const color = currentColor();
  const selection = `${product.name} · ${state.capacity} · ${color.label}`;
  const c = counts();
  const ready = state.status === 'ready';

  let kind = state.status;
  let title;
  let sub = selection;
  let mobile;

  if (state.status === 'loading') {
    title = '<span class="skeleton-text">正在查询库存</span>';
    mobile = '正在查询…';
  } else if (state.status === 'gate') {
    title = '预购尚未开放';
    sub = `${dateLabel(product.preorderAt, true)} · ${selection}`;
    mobile = '等待预购开放';
  } else if (state.status === 'error') {
    title = '暂时无法确认库存';
    sub = selection;
    mobile = '数据源异常';
  } else if (c.available > 0) {
    kind = 'available';
    title = `<span class="num">${c.available}</span> 家门店可取货`;
    mobile = `${c.available} 家门店可取货`;
  } else if (c.total && c.unknown === c.total) {
    kind = 'unknown';
    title = '无法确认库存';
    sub = `Apple 未返回完整结果，请稍后刷新 · ${selection}`;
    mobile = '库存未确认';
  } else {
    kind = 'none';
    title = '暂无门店可取货';
    mobile = '暂无门店可取货';
  }

  const demo = state.demo || state.lastResult?.demo;
  els.summaryCard.className = `summary panel ${kind}${demo && ready ? ' demo' : ''}`;
  els.summaryTitle.innerHTML = title;
  els.selectionSummary.textContent = sub;

  const show = ready && c.total;
  els.availableCount.textContent = show ? c.available : '—';
  els.unavailableCount.textContent = show ? c.unavailable : '—';
  els.unknownCount.textContent = show ? c.unknown : '—';
  const [segA, segU, segN] = els.distBar.children;
  const pct = n => (show ? `calc(${(n / c.total) * 100}% - ${n ? 2 : 0}px)` : '0');
  segA.style.width = pct(c.available);
  segU.style.width = pct(c.unknown);
  segN.style.width = pct(c.unavailable);

  els.allTabCount.textContent = show ? c.total : '';
  els.availableTabCount.textContent = show ? c.available : '';

  els.mobileDot.className = `mobile-dot ${kind}`;
  els.mobileSelection.textContent = mobile;
  els.mobileRegion.textContent = `${region.label} · ${state.capacity} · ${color.label}`;
}

function skeletonRows(n) {
  return Array.from({ length: n }, () => `
    <div class="skeleton-row" aria-hidden="true">
      <span class="sk circle"></span>
      <span><span class="sk line w1" style="display:block"></span><span class="sk line w2" style="display:block"></span></span>
      <span class="sk pill"></span>
    </div>`).join('');
}

function emptyState({ icon, title, body = '', action = null }) {
  return `<div class="empty">
    <div class="empty-art" aria-hidden="true">${icon}</div>
    <strong>${title}</strong>${body ? `<p>${body}</p>` : ''}
    ${action ? `<button class="btn btn-secondary" type="button" data-action="${action.id}">${action.label}</button>` : ''}
  </div>`;
}

function renderStores() {
  renderSummary();
  const region = currentRegion();

  if (state.status === 'loading') {
    els.storeList.innerHTML = skeletonRows(Math.min(Math.max(region.stores.length, 2), 6));
    return;
  }
  if (state.status === 'gate') {
    els.storeList.innerHTML = emptyState({
      icon: icons.clock,
      title: '等待 Apple 开放预购',
      body: dateLabel(currentProduct().preorderAt, true)
    });
    return;
  }
  if (state.status === 'error') {
    els.storeList.innerHTML = emptyState({
      icon: icons.alert,
      title: '查询失败',
      action: { id: 'retry', label: '重试' }
    });
    return;
  }

  let stores = [...state.stores].sort((a, b) =>
    statusMeta(a.status).rank - statusMeta(b.status).rank || (a.distance ?? 1e9) - (b.distance ?? 1e9));
  if (state.filter === 'available') stores = stores.filter(store => store.status === 'available');

  if (!stores.length) {
    els.storeList.innerHTML = state.filter === 'available' && state.stores.length
      ? emptyState({ icon: icons.store, title: '暂无门店可取货', action: { id: 'show-all', label: '查看全部门店' } })
      : emptyState({ icon: icons.store, title: '没有可显示的库存结果' });
    return;
  }

  const href = escapeHtml(appleUrl());
  els.storeList.innerHTML = stores.map((store, index) => {
    const meta = statusMeta(store.status);
    const detail = store.quote || meta.detail;
    const extra = store.missingFromResponse ? '<span class="tag warn">响应缺失</span>' : store.discovered ? '<span class="tag">新发现</span>' : '';
    const cta = store.status === 'available'
      ? `<a class="btn btn-primary cta" href="${href}" target="_blank" rel="noopener" aria-label="前往 Apple 官网购买并选择 Apple ${escapeHtml(store.name)} 取货">购买</a>`
      : '<span class="cta-spacer" aria-hidden="true"></span>';
    return `
      <article class="store-row ${meta.className}" style="--delay:${Math.min(index * 30, 210)}ms">
        <div class="status-icon ${meta.className}" aria-hidden="true">${meta.icon}</div>
        <div class="store-info">
          <div class="store-name"><strong>Apple ${escapeHtml(store.name)}</strong>${extra}</div>
          <div class="store-meta"><span>${escapeHtml(store.city || region.label)}</span>${store.distance != null ? `<span>${Number(store.distance).toFixed(1)} km</span>` : ''}<span class="mono">${escapeHtml(store.id || '')}</span></div>
        </div>
        <div class="stock"><span class="badge">${meta.label}</span><small>${escapeHtml(detail)}</small></div>
        ${cta}
      </article>`;
  }).join('');
}

function renderFreshness(result) {
  if (!result) {
    els.freshness.className = 'freshness';
    els.freshness.innerHTML = '<span></span>等待查询';
    return;
  }
  if (result.stale) {
    const age = Math.max(1, Math.round((result.staleAgeMs || 0) / 1000));
    els.freshness.className = 'freshness stale';
    els.freshness.innerHTML = `<span></span>Apple 暂时异常 · ${age} 秒前缓存`;
    return;
  }
  const labels = { HIT: '缓存', MISS: '实时', DEMO: '交互预览' };
  els.freshness.className = `freshness ${result.demo ? 'demo' : 'live'}`;
  els.freshness.innerHTML = `<span></span>${labels[result.cache] || 'Apple 数据'}`;
}

function scheduleRefresh() {
  clearInterval(state.timer);
  if (!state.autoRefresh || phase() === 'prelaunch') return;
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !state.loading) refresh({ silent: true, auto: true });
  }, 15_000);
}

const guard = new RequestGuard();
const selectionNow = () => ({
  product: state.product, capacity: state.capacity, color: state.color, region: state.region
});

async function refresh({ forceDemo = false, silent = false, auto = false } = {}) {
  // Never drop a new request just because one is in flight — see request-guard.js.
  const token = guard.begin(selectionNow());
  state.loading = true;
  els.refreshButton.classList.add('spinning');
  if (!silent) els.mobileRefresh.textContent = '查询中';

  // Results for a different selection must never sit under the new one while it loads.
  if (!sameSelection(state.renderedSelection, selectionNow()) || state.status === 'error') {
    state.status = 'loading';
    state.stores = [];
    els.updatedTime.textContent = '—';
    renderFreshness(null);
    renderStores();
  }

  try {
    const useDemo = forceDemo || state.demo;
    const endpoint = useDemo
      ? `/api/demo?region=${encodeURIComponent(state.region)}`
      : `/api/availability?product=${encodeURIComponent(state.product)}&capacity=${encodeURIComponent(state.capacity)}&color=${encodeURIComponent(state.color)}&region=${encodeURIComponent(state.region)}${auto ? '&auto=1' : ''}`;

    const response = await fetch(endpoint, { cache: 'no-store', signal: token.signal });
    const result = await response.json();

    if (!guard.isCurrent(token, selectionNow())) return;
    state.renderedSelection = selectionNow();

    if (result.gate === 'preorder-not-open') {
      state.stores = [];
      state.lastResult = result;
      state.status = 'gate';
      sourceState('waiting', '等待预购');
      els.updatedTime.textContent = '待开放';
      renderFreshness(null); renderStores(); scheduleRefresh(); return;
    }

    if (!response.ok || !result.ok) throw new Error(result.error || 'QUERY_FAILED');

    state.stores = result.stores || [];
    state.lastResult = result;
    state.status = 'ready';
    const time = new Date(result.fetchedAt);
    els.updatedTime.textContent = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (result.stale) sourceState('degraded', 'Apple 异常 · 使用缓存');
    else if (useDemo) sourceState('demo', '交互预览');
    else sourceState('online', '数据源正常');

    renderFreshness(result);
    renderStores();
    if (forceDemo) toast('交互预览');
  } catch (error) {
    // A cancelled request is not a failure — it was superseded on purpose. Rendering an
    // error here would wipe the newer request's result that is already on screen.
    if (RequestGuard.isAbort(error)) return;
    if (!guard.isCurrent(token, selectionNow())) return;
    state.renderedSelection = selectionNow();
    state.stores = [];
    state.lastResult = null;
    state.status = 'error';
    els.updatedTime.textContent = '异常';
    sourceState('error', '数据源异常');
    renderFreshness(null);
    renderStores();
    if (!silent) toast('查询失败');
  } finally {
    // Only the newest request owns the shared UI affordances.
    if (guard.owns(token)) {
      state.loading = false;
      guard.settle(token);
      setTimeout(() => els.refreshButton.classList.remove('spinning'), 320);
      els.mobileRefresh.textContent = '刷新';
      scheduleRefresh();
    }
  }
}

async function loadWatches() {
  try {
    const response = await fetch('/api/watches', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'WATCH_LOAD_FAILED');
    state.watches = result.watches || [];
  } catch {
    state.watches = [];
  }
  renderWatch();
}

async function toggleWatch() {
  // A pre-launch product CAN be armed: the monitor skips it until its window opens, so
  // arming early costs nothing and is the only useful action before a launch.
  if (state.watchLoading || state.demo) return;
  const existing = currentWatch();
  state.watchLoading = true;
  renderWatch();

  let permissionPromise = null;
  if (!existing && 'Notification' in window && Notification.permission === 'default') {
    permissionPromise = Notification.requestPermission().catch(() => 'default');
  }

  try {
    if (existing) {
      const response = await fetch(`/api/watches/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'WATCH_DELETE_FAILED');
      toast('已停止监控当前配置');
    } else {
      const response = await fetch('/api/watches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: state.product, capacity: state.capacity, color: state.color, region: state.region })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'WATCH_CREATE_FAILED');
      const permission = permissionPromise ? await permissionPromise : ('Notification' in window ? Notification.permission : 'unsupported');
      toast('已开启监控');
    }
    await loadWatches();
  } catch {
    toast(existing ? '停止监控失败，请稍后重试' : '开启监控失败，请稍后重试');
  } finally {
    state.watchLoading = false;
    renderWatch();
  }
}

/**
 * 到货提示音。
 *
 * 浏览器的自动播放策略要求 AudioContext 先由一次用户手势解锁，所以这里在首次
 * pointerdown/keydown 时就建好 context，等真正有货时只需 resume。用振荡器合成
 * 而不是加载音频文件：不多一个网络请求，离线也能响。
 */
const chime = {
  ctx: null,

  /** 建好（或恢复）context 并返回它；没有 Web Audio 时返回 null。 */
  unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!this.ctx) {
      try { this.ctx = new Ctx(); } catch { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  play() {
    if (!state.sound || document.visibilityState !== 'visible') return;
    const ctx = this.unlock();
    if (!ctx) return;
    if (ctx.state === 'running') { this.ring(ctx); return; }
    // resume() 是异步的，首次播放时可能还没切到 running，等它落地再发声。
    ctx.resume().then(() => this.ring(ctx)).catch(() => {});
  },

  ring(ctx) {
    const base = ctx.currentTime + 0.02;
    // 两次上行双音：单响一声容易在嘈杂环境里被忽略。
    for (const offset of [0, 0.6]) {
      for (const [freq, step] of [[880, 0], [1318.5, 0.15]]) {
        const at = base + offset + step;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(0.22, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0008, at + 0.32);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.34);
      }
    }
  }
};

async function showStockNotification(event) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `Apple ${event.storeName} 已有货`;
  const body = `${event.productName} · ${event.capacity} · ${event.colorLabel}`;
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, { body, icon: '/icon.svg', tag: `${event.sku}:${event.storeId}`, data: { url: event.appleUrl }, silent: state.sound && document.visibilityState === 'visible' });
    } else {
      new Notification(title, { body });
    }
  } catch {}
}

function connectEventStream() {
  state.eventSource?.close();
  const stream = new EventSource('/api/stream');
  state.eventSource = stream;
  stream.addEventListener('stock', async message => {
    try {
      const event = JSON.parse(message.data);
      chime.play();
      toast(`Apple ${event.storeName} 已显示可取货`);
      await showStockNotification(event);
      if (event.sku === currentVariant()?.sku && event.region === state.region) refresh({ silent: true, auto: true });
      await loadWatches();
    } catch {}
  });
}

// ---- region sheet ------------------------------------------------------------

function renderRegionList(filter = '') {
  const term = filter.trim().toLowerCase();
  const entries = Object.entries(state.catalog.regions)
    .filter(([id, region]) => !term || region.label.includes(term) || id.includes(term))
    .sort((a, b) => b[1].stores.length - a[1].stores.length || a[1].label.localeCompare(b[1].label, 'zh-CN'));

  els.regionList.innerHTML = entries.map(([id, region]) => {
    const active = id === state.region;
    return `<button class="region-item ${active ? 'active' : ''}" type="button" data-region="${id}" aria-current="${active}">
      <span><strong>${region.label}</strong></span>
      ${active ? icons.checkBold : `<span class="region-count">${region.stores.length} 家</span>`}
    </button>`;
  }).join('') || '<div class="no-results">没有匹配的城市</div>';
}

function openRegionModal() {
  els.regionModal.hidden = false;
  document.body.classList.add('modal-open');
  els.regionSearch.value = '';
  renderRegionList();
  // Touch devices would pop the keyboard over the list; only autofocus with a fine pointer.
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => els.regionSearch.focus(), 40);
}

function closeRegionModal() {
  els.regionModal.hidden = true;
  document.body.classList.remove('modal-open');
  els.regionButton.focus({ preventScroll: true });
}

function selectRegion(id) {
  if (!state.catalog.regions[id]) return;
  state.region = id;
  persist();
  closeRegionModal();
  renderControls();
  refresh();
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function useLocation() {
  if (!navigator.geolocation) return toast('当前浏览器不支持定位');
  const label = els.locationButton.querySelector('span');
  label.textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(position => {
    const { latitude, longitude } = position.coords;
    let best = null;
    for (const [id, region] of Object.entries(state.catalog.regions)) {
      const distance = haversine(latitude, longitude, region.lat, region.lon);
      if (!best || distance < best.distance) best = { id, distance };
    }
    label.textContent = '使用我的位置';
    if (!best) return toast('无法匹配附近城市');
    selectRegion(best.id);
    toast(`已选择最近的城市：${state.catalog.regions[best.id].label}`);
  }, () => {
    label.textContent = '使用我的位置';
    toast('定位未授权');
  }, { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 });
}

function setFilter(filter) {
  state.filter = filter;
  $$('.filter-tab').forEach(item => {
    const on = item.dataset.filter === filter;
    item.classList.toggle('active', on);
    item.setAttribute('aria-selected', String(on));
  });
  renderStores();
}

// ---- events ----------------------------------------------------------------

function setupEvents() {
  els.refreshButton.addEventListener('click', () => refresh());
  els.mobileRefresh.addEventListener('click', () => refresh());
  document.querySelector('.mobile-copy').addEventListener('click', () => els.summaryCard.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  els.watchButton.addEventListener('click', toggleWatch);
  els.regionButton.addEventListener('click', openRegionModal);
  els.locationButton.addEventListener('click', useLocation);
  els.regionSearch.addEventListener('input', event => renderRegionList(event.target.value));
  els.regionSearch.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const first = els.regionList.querySelector('.region-item');
    if (first) selectRegion(first.dataset.region);
  });

  // Delegated: these lists are re-rendered on every selection change.
  els.productOptions.addEventListener('click', event => {
    const button = event.target.closest('[data-product]');
    if (button) selectProduct(button.dataset.product);
  });
  els.capacityOptions.addEventListener('click', event => {
    const button = event.target.closest('[data-capacity]');
    if (!button || button.dataset.capacity === state.capacity) return;
    state.capacity = button.dataset.capacity;
    persist(); renderControls(); refresh();
  });
  els.colorOptions.addEventListener('click', event => {
    const button = event.target.closest('[data-color]');
    if (!button || button.dataset.color === state.color) return;
    state.color = button.dataset.color;
    persist(); renderControls(); refresh();
  });
  els.regionList.addEventListener('click', event => {
    const button = event.target.closest('[data-region]');
    if (button) selectRegion(button.dataset.region);
  });
  els.storeList.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'retry') refresh();
    if (action === 'show-all') setFilter('all');
  });

  $$('[data-close-modal]').forEach(el => el.addEventListener('click', closeRegionModal));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !els.regionModal.hidden) closeRegionModal(); });
  ['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, () => chime.unlock(), { once: true, passive: true }));
  els.soundAlert.checked = state.sound;
  els.soundAlert.addEventListener('change', event => {
    state.sound = event.target.checked; persist();
    if (state.sound) chime.play();
    toast(state.sound ? '已开启到货提示音' : '已关闭到货提示音');
  });
  els.autoRefresh.checked = state.autoRefresh;
  els.autoRefresh.addEventListener('change', event => {
    state.autoRefresh = event.target.checked; persist(); scheduleRefresh();
    toast(state.autoRefresh ? '自动刷新已开启' : '自动刷新已关闭');
  });
  $$('.filter-tab').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
  els.demoButton.addEventListener('click', () => { state.demo = true; renderWatch(); refresh({ forceDemo: true }); });
  els.sourceButton.addEventListener('click', () => refresh());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadWatches();
      if (state.autoRefresh) refresh({ silent: true, auto: true });
    }
  });
}

async function init() {
  try {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    const data = await response.json();
    if (!data.ok) throw new Error('CATALOG_LOAD_FAILED');
    state.catalog = data.catalog;
    state.phases = data.phases || {};
    if (!state.catalog.products[state.product]) state.product = data.defaultProduct || state.catalog.defaultProduct;
    const product = currentProduct();
    if (!product.variants[`${state.capacity}:${state.color}`]) {
      state.capacity = product.capacities[0];
      state.color = product.colors[0].id;
    }
    if (!state.catalog.regions[state.region]) state.region = 'beijing';
    persist();

    const regions = Object.values(state.catalog.regions);
    els.cityCount.textContent = `${regions.length} 个城市`;
    els.storeCount.textContent = `${regions.reduce((sum, region) => sum + region.stores.length, 0)} 家 Apple Store`;

    renderControls(); renderPhase(); renderStores(); setupEvents();
    clearInterval(state.phaseTimer);
    state.phaseTimer = setInterval(renderPhase, 1000);

    // Registration must not gate the first query — the answer matters more than the shell cache.
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (query.get('snapshot') !== '1') connectEventStream();
    await Promise.all([loadWatches(), refresh()]);
  } catch (error) {
    sourceState('error', '服务未连接');
    els.summaryCard.className = 'summary panel error';
    els.summaryTitle.textContent = '无法加载产品目录';
    els.selectionSummary.textContent = '';
    els.storeList.innerHTML = emptyState({ icon: icons.alert, title: '无法加载产品目录' });
    toast('无法加载产品目录');
  }
}

init();
