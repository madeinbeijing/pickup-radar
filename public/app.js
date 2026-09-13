import { RequestGuard } from '/request-guard.js';

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
  capacityOptions: $('#capacityOptions'), colorOptions: $('#colorOptions'), priceLabel: $('#priceLabel'), skuLabel: $('#skuLabel'),
  deviceArt: $('#deviceArt'), regionButton: $('#regionButton'), regionLabel: $('#regionLabel'), regionMeta: $('#regionMeta'),
  locationButton: $('#locationButton'), selectionSummary: $('#selectionSummary'), appleProductLink: $('#appleProductLink'),
  watchCard: $('#watchCard'), watchTitle: $('#watchTitle'), watchMeta: $('#watchMeta'), watchButton: $('#watchButton'),
  resultsRegionLabel: $('#resultsRegionLabel'), phaseCopy: $('#phaseCopy'), phaseBanner: $('#phaseBanner'), phaseTitle: $('#phaseTitle'),
  phaseCountdownLabel: $('#phaseCountdownLabel'), countdown: $('#countdown'),
  availableCount: $('#availableCount'), checkedCount: $('#checkedCount'), unknownCount: $('#unknownCount'), updatedTime: $('#updatedTime'),
  freshness: $('#freshness'), storeList: $('#storeList'), autoRefresh: $('#autoRefresh'), soundAlert: $('#soundAlert'), demoButton: $('#demoButton'),
  regionModal: $('#regionModal'), regionSearch: $('#regionSearch'), regionList: $('#regionList'), cityCount: $('#cityCount'), storeCount: $('#storeCount'),
  mobileRegion: $('#mobileRegion'), mobileSelection: $('#mobileSelection'), mobileRefresh: $('#mobileRefresh'), toast: $('#toast')
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

/** "10 月 16 日晚 8 点" style label, derived from the product rather than hardcoded. */
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
  if (days > 0) return `${days}天 ${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

function relativeCheck(iso) {
  if (!iso) return '等待首次成功检查';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前检查`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} 分钟前检查`;
}

function renderPhase() {
  const p = phase();
  const product = currentProduct();
  if (!product) return;
  const now = Date.now();
  els.phaseBanner.className = `phase-banner ${p}`;

  if (p === 'prelaunch') {
    els.phaseCopy.textContent = `${dateLabel(product.preorderAt, true)} 开始预购`;
    els.phaseTitle.textContent = '预购尚未开放';
    els.phaseCountdownLabel.textContent = '距预购';
    els.countdown.textContent = formatDuration(new Date(product.preorderAt).getTime() - now);
  } else if (p === 'preorder') {
    els.phaseCopy.textContent = `预购已开放 · ${dateLabel(product.releaseAt)}发售`;
    els.phaseTitle.textContent = '预购已开放';
    els.phaseCountdownLabel.textContent = '距发售';
    els.countdown.textContent = formatDuration(new Date(product.releaseAt).getTime() - now);
  } else {
    els.phaseCopy.textContent = '现已发售';
    els.phaseTitle.textContent = '现货查询';
    els.phaseCountdownLabel.textContent = '状态';
    els.countdown.textContent = '已发售';
  }
  renderWatch();
}

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
    return `<button class="choice product-choice ${item.id === product.id ? 'active' : ''}" type="button"
      data-product="${item.id}" role="radio" aria-checked="${item.id === product.id}">
      <strong>${item.name}</strong><small>${tag}</small></button>`;
  }).join('');

  els.capacityOptions.innerHTML = product.capacities.map(capacity => `
    <button class="choice ${capacity === state.capacity ? 'active' : ''}" type="button" data-capacity="${capacity}" role="radio" aria-checked="${capacity === state.capacity}">${capacity}</button>
  `).join('');

  els.colorOptions.innerHTML = product.colors.map(item => `
    <button class="color-choice ${item.id === state.color ? 'active' : ''}" type="button" data-color="${item.id}" role="radio" aria-checked="${item.id === state.color}">
      <span class="swatch" style="--swatch:${item.swatch}"></span><span>${item.label}</span>
    </button>
  `).join('');

  els.priceLabel.textContent = `¥${money(variant.price)}`;
  els.skuLabel.textContent = variant.sku;
  els.deviceArt.className = `device-art ${state.color} ${product.id === 'iphone-duo' ? 'is-fold' : ''}`;
  els.regionLabel.textContent = region.label;
  els.regionMeta.textContent = `${region.stores.length} 家 Apple Store`;
  els.resultsRegionLabel.textContent = `${region.label} · ${region.stores.length} 家直营店`;
  els.selectionSummary.textContent = `${product.name} · ${state.capacity} · ${color.label} · ${region.label}`;
  els.appleProductLink.href = appleUrl();
  els.mobileRegion.textContent = `${product.name} · ${region.label}`;
  els.mobileSelection.textContent = color.label;
  renderWatch();

  $$('#productOptions .product-choice').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.product === state.product) return;
    state.product = button.dataset.product;
    // Capacities and colors are per-product; snap the selection onto the new product's
    // options so a Duo colour is never carried over to an 18 Pro Max query.
    const next = currentProduct();
    if (!next.capacities.includes(state.capacity)) state.capacity = next.capacities[0];
    if (!next.colors.some(c => c.id === state.color)) state.color = next.colors[0].id;
    state.stores = [];
    persist(); renderControls(); renderPhase(); refresh();
  }));

  $$('#capacityOptions .choice').forEach(button => button.addEventListener('click', () => {
    state.capacity = button.dataset.capacity;
    persist(); renderControls(); refresh();
  }));
  $$('#colorOptions .color-choice').forEach(button => button.addEventListener('click', () => {
    state.color = button.dataset.color;
    persist(); renderControls(); refresh();
  }));
}

function renderWatch() {
  if (!state.catalog || !els.watchCard) return;
  const watch = currentWatch();
  // A pre-launch product can still be armed: the monitor skips it until its window
  // opens, so arming early costs nothing and is exactly what a user wants beforehand.
  const blocked = state.demo;
  els.watchCard.classList.toggle('active', Boolean(watch));
  els.watchCard.classList.toggle('disabled', blocked && !watch);
  els.watchButton.disabled = state.watchLoading || (blocked && !watch);

  if (state.watchLoading) {
    els.watchButton.textContent = '处理中…';
    return;
  }

  if (watch) {
    const armed = phase() === 'prelaunch';
    els.watchTitle.textContent = armed ? '已布控，等待预购开放' : '已持续监控当前配置';
    els.watchMeta.textContent = armed
      ? `${dateLabel(currentProduct().preorderAt, true)} 起自动查询`
      : relativeCheck(watch.lastCheckedAt);
    els.watchButton.textContent = armed ? '取消布控' : '停止监控';
    return;
  }

  if (state.demo) {
    els.watchTitle.textContent = '交互预览不创建监控';
    els.watchMeta.textContent = '';
    els.watchButton.textContent = '预览模式';
    return;
  }
  if (phase() === 'prelaunch') {
    const product = currentProduct();
    els.watchTitle.textContent = '可提前布控';
    els.watchMeta.textContent = `${dateLabel(product.preorderAt, true)} 预购开放后自动开始监控`;
    els.watchButton.textContent = '提前布控';
    return;
  }

  els.watchTitle.textContent = '当前配置未监控';
  els.watchMeta.textContent = '';
  els.watchButton.textContent = '开启监控';
}

function statusMeta(status) {
  if (status === 'available') return { label: '有货', detail: '可到店取货', className: 'available' };
  if (status === 'unavailable') return { label: '无货', detail: '暂不可取货', className: 'unavailable' };
  if (status === 'ineligible') return { label: '不可取货', detail: '此配置暂不支持', className: 'ineligible' };
  return { label: '未确认', detail: '查询结果不完整', className: 'unknown' };
}

function renderMetrics() {
  const available = state.stores.filter(store => store.status === 'available').length;
  const confirmed = state.stores.filter(store => ['available','unavailable','ineligible'].includes(store.status)).length;
  const unknown = state.stores.filter(store => store.status === 'unknown').length;
  els.availableCount.textContent = state.stores.length ? available : '—';
  els.checkedCount.textContent = state.stores.length ? confirmed : '—';
  els.unknownCount.textContent = state.stores.length ? unknown : '—';
}

function renderStores() {
  renderMetrics();
  let stores = [...state.stores];
  if (state.filter === 'available') stores = stores.filter(store => store.status === 'available');

  if (!stores.length) {
    els.storeList.innerHTML = emptyState(
      state.filter === 'available' && state.stores.length ? '当前没有确认有货的门店' : '没有可显示的库存结果'
    );
    return;
  }

  els.storeList.innerHTML = stores.map((store, index) => {
    const meta = statusMeta(store.status);
    const detail = store.quote || meta.detail;
    const extra = store.missingFromResponse ? '<span class="micro-tag warn">响应缺失</span>' : store.discovered ? '<span class="micro-tag">新发现</span>' : '';
    return `
      <article class="store-row ${meta.className}" style="--delay:${Math.min(index * 28, 196)}ms">
        <div class="status-symbol ${meta.className}"><span></span></div>
        <div class="store-info">
          <div class="store-name"><strong>Apple ${escapeHtml(store.name)}</strong>${extra}</div>
          <div class="store-meta"><span>${escapeHtml(store.city || currentRegion().label)}</span>${store.distance != null ? `<span>${Number(store.distance).toFixed(1)} km</span>` : ''}<span>${escapeHtml(store.id || '')}</span></div>
        </div>
        <div class="stock-copy"><strong>${meta.label}</strong><small>${escapeHtml(detail)}</small></div>
        <a class="apple-cta ${store.status !== 'available' ? 'muted' : ''}" href="${appleUrl()}" target="_blank" rel="noopener" aria-label="前往 Apple 官方购买页">Apple ↗</a>
      </article>`;
  }).join('');
}

function emptyState(title) {
  return `<div class="loading-state"><div class="radar" aria-hidden="true"><span></span><span></span><i></i></div><strong>${title}</strong></div>`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
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
  const labels = { HIT: '缓存命中', MISS: 'Apple 实时响应', DEMO: '交互预览' };
  els.freshness.className = `freshness ${result.demo ? 'demo' : 'live'}`;
  els.freshness.innerHTML = `<span></span>${labels[result.cache] || 'Apple 数据'}`;
}

function scheduleRefresh() {
  clearInterval(state.timer);
  if (!state.autoRefresh || phase() === 'prelaunch') return;
  state.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !state.loading) refresh({ silent: true });
  }, 15_000);
}

const guard = new RequestGuard();
const selectionNow = () => ({
  product: state.product, capacity: state.capacity, color: state.color, region: state.region
});

async function refresh({ forceDemo = false, silent = false } = {}) {
  // Never drop a new request just because one is in flight — see request-guard.js.
  const token = guard.begin(selectionNow());
  state.loading = true;
  els.refreshButton.classList.add('spinning');
  if (!silent) els.mobileRefresh.textContent = '查询中…';

  try {
    const useDemo = forceDemo || state.demo;
    const endpoint = useDemo
      ? `/api/demo?region=${encodeURIComponent(state.region)}`
      : `/api/availability?product=${encodeURIComponent(state.product)}&capacity=${encodeURIComponent(state.capacity)}&color=${encodeURIComponent(state.color)}&region=${encodeURIComponent(state.region)}`;

    const response = await fetch(endpoint, { cache: 'no-store', signal: token.signal });
    const result = await response.json();

    if (!guard.isCurrent(token, selectionNow())) return;

    if (result.gate === 'preorder-not-open') {
      state.stores = [];
      state.lastResult = result;
      sourceState('waiting', '等待预购');
      els.updatedTime.textContent = '待开放';
      els.storeList.innerHTML = emptyState('等待 Apple 开放预购');
      renderMetrics(); renderFreshness(null); scheduleRefresh(); return;
    }

    if (!response.ok || !result.ok) throw new Error(result.error || 'QUERY_FAILED');

    state.stores = result.stores || [];
    state.lastResult = result;
    const time = new Date(result.fetchedAt);
    els.updatedTime.textContent = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (result.stale) sourceState('degraded', 'Apple 异常 · 使用缓存');
    else if (useDemo) sourceState('demo', '交互预览');
    else sourceState('online', 'Apple 数据源正常');

    renderFreshness(result);
    renderStores();
    if (forceDemo) toast('已切换到交互预览；这些库存不是实时数据');
  } catch (error) {
    // A cancelled request is not a failure — it was superseded on purpose. Rendering an
    // error here would wipe the newer request's result that is already on screen.
    if (RequestGuard.isAbort(error)) return;
    if (!guard.isCurrent(token, selectionNow())) return;
    state.stores = [];
    state.lastResult = null;
    els.updatedTime.textContent = '异常';
    sourceState('error', 'Apple 数据源异常');
    renderFreshness(null);
    renderStores();
    if (!silent) toast('查询失败：已标记为异常，不会显示成“无货”');
  } finally {
    // Only the newest request owns the shared UI affordances.
    if (guard.owns(token)) {
      state.loading = false;
      guard.settle(token);
      setTimeout(() => els.refreshButton.classList.remove('spinning'), 320);
      els.mobileRefresh.textContent = '刷新库存';
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
      toast(permission === 'granted' ? '已开启监控和浏览器到货提醒' : '已开启服务端监控');
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
      if (event.sku === currentVariant()?.sku && event.region === state.region) refresh({ silent: true });
      await loadWatches();
    } catch {}
  });
}

function renderRegionList(filter = '') {
  const term = filter.trim().toLowerCase();
  const entries = Object.entries(state.catalog.regions)
    .filter(([id, region]) => !term || region.label.includes(term) || id.includes(term))
    .sort((a,b) => b[1].stores.length - a[1].stores.length || a[1].label.localeCompare(b[1].label, 'zh-CN'));

  els.regionList.innerHTML = entries.map(([id, region]) => `
    <button class="region-item ${id === state.region ? 'active' : ''}" type="button" data-region="${id}">
      <span><strong>${region.label}</strong><small>${region.stores.length} 家 Apple Store</small></span>
      <span class="region-check">${id === state.region ? '✓' : '›'}</span>
    </button>
  `).join('') || '<div class="no-results">没有匹配的城市</div>';

  $$('#regionList .region-item').forEach(button => button.addEventListener('click', () => selectRegion(button.dataset.region)));
}

function openRegionModal() {
  els.regionModal.hidden = false;
  document.body.classList.add('modal-open');
  els.regionSearch.value = '';
  renderRegionList();
  setTimeout(() => els.regionSearch.focus(), 40);
}

function closeRegionModal() {
  els.regionModal.hidden = true;
  document.body.classList.remove('modal-open');
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
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function useLocation() {
  if (!navigator.geolocation) return toast('当前浏览器不支持定位');
  els.locationButton.textContent = '定位中…';
  navigator.geolocation.getCurrentPosition(position => {
    const { latitude, longitude } = position.coords;
    let best = null;
    for (const [id, region] of Object.entries(state.catalog.regions)) {
      const distance = haversine(latitude, longitude, region.lat, region.lon);
      if (!best || distance < best.distance) best = { id, distance };
    }
    els.locationButton.textContent = '使用我的位置';
    if (!best) return toast('无法匹配附近城市');
    selectRegion(best.id);
    toast(`已选择最近的 Apple Store 城市：${state.catalog.regions[best.id].label}`);
  }, () => {
    els.locationButton.textContent = '使用我的位置';
    toast('定位未授权，可手动选择城市');
  }, { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 });
}

function setupEvents() {
  els.refreshButton.addEventListener('click', () => refresh());
  els.mobileRefresh.addEventListener('click', () => refresh());
  els.watchButton.addEventListener('click', toggleWatch);
  els.regionButton.addEventListener('click', openRegionModal);
  els.locationButton.addEventListener('click', useLocation);
  els.regionSearch.addEventListener('input', event => renderRegionList(event.target.value));
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
    toast(state.autoRefresh ? '已开启 15 秒页面自动刷新' : '已暂停页面自动刷新；服务端监控不受影响');
  });
  $$('.filter-tab').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter-tab').forEach(item => item.classList.toggle('active', item === button));
    renderStores();
  }));
  els.demoButton.addEventListener('click', () => { state.demo = true; renderWatch(); refresh({ forceDemo: true }); });
  els.sourceButton.addEventListener('click', () => toast('库存源：Apple 中国官网 /shop/retail/pickup-message'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadWatches();
      if (state.autoRefresh) refresh({ silent: true });
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
    els.storeCount.textContent = `${regions.reduce((sum, region) => sum + region.stores.length, 0)} 家直营店`;

    renderControls(); renderPhase(); setupEvents();
    clearInterval(state.phaseTimer);
    state.phaseTimer = setInterval(renderPhase, 1000);

    if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (query.get('snapshot') !== '1') connectEventStream();
    await Promise.all([loadWatches(), refresh()]);
  } catch (error) {
    sourceState('error', '服务未连接');
    els.storeList.innerHTML = emptyState('无法加载产品目录');
    toast('无法加载产品目录');
  }
}

init();
