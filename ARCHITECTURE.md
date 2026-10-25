# Pickup Radar — Production Architecture

## 1. 产品目标

Pickup 的任务不是“展示 Apple 商品”，而是把用户最关键的一条路径压缩到最短：

```text
选择目标配置
    ↓
确认哪个直营店有货
    ↓
立即进入 Apple 官方购买页
```

因此系统优化目标按优先级排序为：

1. **正确性**：绝不把请求失败解释成无货。
2. **新鲜度**：在合理上游压力下尽可能快地发现库存变化。
3. **触达速度**：状态变化后尽快通知用户。
4. **可解释性**：用户能看出数据是实时、缓存还是未知。
5. **可扩展性**：用户数增长不能线性放大 Apple 请求量。

---

## 2. v2.3 实现

```text
Browser / PWA
   │  availability query (带请求版本+选择快照) · watch CRUD · SSE (Last-Event-ID)
   ▼
HTTP layer  ── rate limit · session cookie · ETag/304 · graceful shutdown(退出码有意义)
   │
   ├──────────────► StateStore      去抖合并写 · fsync · 原子 rename · 损坏隔离 · schema v4
   │                                关注 / 事件 / 覆盖图 / 通知发件箱
   │
   ├──────────────► StockMonitor    自适应节奏 · 基线与转换判定 · 告警冷却 · 提前布控语义
   │                      │
   │                      ▼
   └──────────────► InventoryService
                          │  ① 折叠所有关注 -> region→SKU 映射
                          ▼
                    CoveragePlanner  ② 贪心集合覆盖，选出最小锚点集
                          │
                          ▼
                    Resilience       ③ 令牌桶 · 并发信号量 · 三态熔断 · 请求合并
                          │
                          ▼
                    Upstream client  ④ 全抖动退避重试 · 限流不重试
                          │
                          ▼
                 apple.com.cn/shop/retail/pickup-message
                          │  store=<anchor>&searchNearby=true  → 门店簇
                          ▼
                    validateContract ⑤ 先校验契约，再宣告成功
                          │
                          ▼
                    Harvest          ⑥ 一次响应写入其覆盖的所有城市缓存
                          │
                          ▼
                    Notifier         ⑦ SSE 即时投递 + 按渠道的持久化发件箱
```

### 2.1 关键设计决策

**① 锚点 + searchNearby，而非 seed store**

v1.1 假设 `store=<seed>` 会返回整城门店。实测只返回 **1 家**，北京 6 家店中 5 家恒为 `unknown`。
加上 `searchNearby=true` 返回门店簇，一次请求解析 6/6，并附带天津 3 家。

**② 覆盖规划器 = 集合覆盖**

门店簇跨城，"每城一请求"是浪费。建模为加权集合覆盖，贪心求解。

*安全不变量*：只有某城**全部**门店都在锚点响应中出现过，才判定覆盖。判断失误的最坏结果是
`unknown`，永远不会变成假的"无货"。覆盖图持久化，重启不必重新摸索。

**③ 对上游的礼貌是硬约束**

令牌桶限速率与突发，信号量限并发。用户增长**不会**线性放大上游请求。

**④ 失败分类决定重试**

只重试幂等 GET 且真正瞬时的故障：超时、socket 错误、**非限流的 5xx**。
限流（429 与 Apple 实测使用的非标准 **541**）不在请求内重试：几秒后重试几乎必然再次被限流，只会加深限流。它们只计入 `throttled` 计数，由监控放慢轮询（每次限流翻倍，每轮成功减半），**不计入熔断器**——否则一次限流既翻倍间隔又停查数分钟。

**⑤ HTTP 200 不等于成功（v2.3）**

`validateContract()` 在宣告成功**之前**校验我们真正依赖的结构。这是全系统最关键的可观测性防线：

| 情形 | 判定 | 后果 |
|---|---|---|
| `body.stores` 不是数组 | 硬失败 | 熔断 + 写入 lastError |
| 门店数为 0 | 硬失败 | 锚点都是真实门店号，0 家意味着结构变了 |
| 请求的 SKU **全部**缺失 | 硬失败 | 熔断 |
| **部分** SKU 缺失 | 警告 | 可能是真的未上架，不熔断 |

在此之前，Apple 一旦改结构，健康页会一直显示绿色、熔断器永不打开，而所有查询静默退化为
`unknown`——即"系统失明且无人知晓"。

**⑥ 收割：一次响应，多城入库**

响应写入它覆盖的**全部**城市缓存。同时：发起请求的城市**始终**被解析，即使 Apple 只返回了
部分门店——缺失的店标为 `unknown`。宁可给部分数据，也不给该城返回空。

**⑦ 通知：投递单位是"事件 × 渠道"（v2.3）**

以事件为重试单位会让已成功的渠道被重复投递。现在每个 (事件, 渠道) 有独立重试计数与幂等键；
退避中的任务保存在 `inflight` 并一并落盘，否则崩溃窗口会吞掉通知。

### 2.2 告警语义

| 规则 | 理由 |
|---|---|
| 首次成功查询只建基线 | 第一次看到有货不是"到货" |
| **提前布控的关注例外**：首轮见到有货即提醒 | 用户在完全买不到时布的控，那一刻就是他等的时刻 |
| 只有**进入** available 才告警 | available→available 不是事件 |
| `unknown → available` 算到货 | 门店确实变为可买 |
| stale 读数不产生事件 | 过期缓存描述的是过去 |
| 每 (关注,门店) 冷却窗口 | 边界抖动不该刷屏 |

**基线推进契约（v2.3 明确化）**：推进基线会**永久丢弃**该转换。只能推进那些转换已真正
送达用户的门店。冷却压制可以推进（用户已被通知过）；任何"用户从未收到"的压制规则都**不得**
推进基线，否则那次到货永久丢失。新增压制条件时必须显式声明属于哪一类。

### 2.3 失败必须可见（v2.3）

| 故障 | 表现 |
|---|---|
| 上游契约破裂 | 熔断打开、`/api/health` 返回 503、`contractFailures` 计数 |
| 单 SKU 投影失败 | `parseErrors` 计数 + warn 日志（不再静默 `continue`） |
| 关闭时落盘失败 | `close()` 抛 `STATE_FLUSH_FAILED`，进程 `exit(1)` |
| 未捕获异常 | `exit(1)`，守护进程可据此重启告警 |
| 状态文件存在但不可读 | 拒绝启动（`STATE_UNREADABLE`），绝不用空状态覆盖；损坏文件无法隔离时同样拒绝 |
| 监控调度链停摆 | 下一轮逾期 2 分钟或单轮超过 5 分钟 → `monitor-stalled`，503 |
| 连续两轮无一关注解析成功 | `rounds-failing`，503（`queryPlan` 不抛错，`lastError` 看不到） |
| 状态 / 统计落盘持续失败 | `degraded`（200）并列出原因；后台重试指数退避至 30s，同类错误只记一次 |
| 覆盖图失准 | 计划内城市照常出结果，缺席门店为 `unknown`；经邻城锚点得到的临时结果不作新鲜缓存，下一轮立即改走本城锚点 |

健康分两级：`down`（503）= 此刻无法发现到货；`degraded`（200）= 提醒仍正常，但有会在之后造成损失的问题。
后者不返回 503，是为了不让守护进程重启一个正在履行主职责的进程。

退出码经子进程实测：正常 SIGTERM → 0；落盘失败 → 1。

### 2.4 目录证据链（v2.3）

目录是手工维护的快照，两类风险：SKU 抄错（该配置将**永远**返回 `unknown` 且无人察觉）、
Apple 改价改配置。

`npm run verify:catalog` 从 Apple 页面重新推导目录并比对，差异则非零退出；
`--write` 另存带 sha256 的快照到 `evidence/catalog-snapshot.json`，使"SKU 来自 Apple"
这一论断可复核而非只能采信。

实现中发现的真实陷阱：Apple 产品名混用 **U+00A0 不换行空格**（`iPhone\u00a018 Pro\u00a0Max`），
直接字符串比较会静默匹配为零。颜色则不做字面比较——我们的 `glacier-blue` 是内部 id，Apple 叫
`Glacier`；改为校验**双射关系**（同一内部色必须映射到同一上游饰面，且两色不得撞同一饰面），
既能抓出真的 SKU 串色，又不会因命名差异误报。

### 2.5 实测数据

| 指标 | v1.1 | v2.3 |
|---|---|---|
| 北京单请求门店解析 | 1 / 6 | **6 / 6** |
| 3 城（京/津/沪）监控一轮的上游请求 | 3 | **2** |
| 北京 + 天津 | 2 | **1** |
| 单请求可携带 SKU | 未验证 | **16（全线）** |
| 目录 SKU 对账 | 无 | **24 / 24 与 Apple 一致** |

---

## 3. v1.1 历史实现（供对照）

```text
Browser / PWA
   │
   ├── availability query
   ├── watch CRUD
   └── SSE event stream
           │
           ▼
Node API + Monitor Process
   │
   ├── Anonymous HttpOnly Session
   ├── Rate Limit
   ├── Request Coalescing
   ├── Fresh / Stale Cache
   ├── Circuit Breaker
   ├── Durable Watch Store
   └── Region Batch Monitor
           │
           ▼
Apple /shop/retail/pickup-message
```

持久化使用原子 JSON 文件，仅为了让完整产品逻辑无需外部服务即可验证。

---

## 4. Apple 上游契约

当前接口：

```text
GET https://www.apple.com.cn/shop/retail/pickup-message
```

核心参数：

```text
pl=true
mts.0=regular
parts.0=<SKU A>
parts.1=<SKU B>
...
store=<seed store>
```

核心响应结构：

```text
body.stores[]
  storeNumber
  storeName
  partsAvailability[SKU]
    pickupDisplay
    messageTypes.regular
```

`pickupDisplay` 只映射：

```text
available   -> available
unavailable -> unavailable
ineligible  -> ineligible
其他/缺失    -> unknown
```

### Contract Guard

必须监控以下异常：

- `body.stores` 不存在
- 整个响应里指定 SKU 完全不存在
- 预期门店没有出现在本轮响应
- HTTP 非 2xx
- JSON 无法解析
- 超时

这些全部属于**数据源异常或未知状态**，不是无货。

---

## 5. 为什么监控必须“按城市批 SKU”

错误模型：

```text
10000 用户 × 关注 1 SKU × 30 秒
= 每 30 秒 10000 次 Apple 请求
```

正确模型：

```text
所有关注
  ↓ group by region
北京: [SKU1, SKU2, SKU3, ...]
上海: [SKU1, SKU5, SKU9, ...]
  ↓
每城市一次批量 parts.N 请求
```

请求量更接近：

```text
活跃城市数 × 批次数
```

而不是用户数。

在更大规模时，对每个城市的 SKU 集合按 10~20 个一批切分，并进行抖动调度（jitter），避免整点惊群。

---

## 6. 到货事件的正确判定

首次加入关注：

```text
当前状态 = available
```

不能立刻发送“刚到货”，因为这只是建立监控时的事实。

因此：

```text
第一次成功查询
    ↓
建立 baseline
    ↓
不通知
```

后续只有：

```text
unavailable / ineligible / unknown
                ↓
             available
```

才生成 `stock_available` 事件。

事件必须是幂等的。生产版建议唯一键：

```text
watch_id + store_id + transition + inventory_version
```

或者使用 Redis SETNX / DB unique constraint 去重。

---

## 7. 生产目标架构

```text
                    ┌──────────────────────┐
                    │     Browser / PWA    │
                    └──────────┬───────────┘
                               │ HTTPS
                               ▼
                    ┌──────────────────────┐
                    │       Web API        │
                    │ auth / catalog / UX  │
                    └──────┬────────┬──────┘
                           │        │
                     PostgreSQL   Redis
                           │        │
                           │        ├─ hot inventory
                           │        ├─ distributed locks
                           │        ├─ pub/sub
                           │        └─ rate limit
                           │
                           ▼
                 ┌──────────────────────┐
                 │   Monitor Scheduler  │
                 │ group region + SKUs  │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Apple Pickup Adapter │
                 │ timeout / contract   │
                 │ circuit / stale      │
                 └──────────┬───────────┘
                            │
                            ▼
                       apple.com.cn
                            │
                            ▼
                 ┌──────────────────────┐
                 │  Inventory Events    │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Notification Worker  │
                 ├──────────────────────┤
                 │ Web Push / WeChat    │
                 │ Bark / SMS optional  │
                 └──────────────────────┘
```

---

## 8. 数据模型

### product_variants

```text
id
product_id
market
sku
capacity
color_id
price
apple_slug
active
verified_at
```

### stores

```text
store_id
name
city_id
lat
lon
active
verified_at
```

### watches

```text
id
user_id / anonymous_session_id
sku
region_id
created_at
enabled
```

### inventory_snapshots

只保存当前状态，不无限追加每一轮轮询：

```text
sku
store_id
status
fetched_at
source_version
```

### inventory_events

只保存变化：

```text
id
sku
store_id
from_status
to_status
occurred_at
fetched_at
```

### notification_deliveries

```text
id
event_id
subscription_id
channel
status
attempt_count
sent_at
error_code
```

---

## 9. 新鲜度语义

前端不得只显示“更新时间”。必须区分：

### LIVE
来自刚刚成功的 Apple 请求。

### FRESH CACHE
来自短 TTL 的成功缓存，仍在产品允许的新鲜度窗口内。

### STALE
Apple 当前请求失败，但存在最近成功快照。

UI 必须明确显示缓存年龄。

### UNKNOWN
没有可信库存可展示。

这四种数据质量状态与门店的 `available/unavailable/ineligible/unknown` 是两个不同维度。

---

## 10. 缓存与并发

当前 v1.1：

- Fresh TTL 12s
- Stale TTL 10m
- 同 key in-flight coalescing
- Circuit Breaker
- region batch query

生产版 Redis key：

```text
inventory:{market}:{region}:{sku}
```

锁：

```text
lock:inventory:{market}:{region}:{batch_hash}
```

使用短分布式锁防止多 worker 同时击穿 Apple。

---

## 11. 轮询策略

不建议所有时间固定 15 秒。

建议动态 cadence：

```text
首发预购 / 发售高峰     15–30s
普通白天               30–60s
深夜低活动             2–5m
连续上游错误            指数退避
无任何关注              不轮询
```

对不同城市增加 0–5 秒 jitter，降低同步峰值。

---

## 12. 通知

v1.1 已有：

- SSE：页面连接时实时事件
- Browser Notification：页面连接时系统通知
- Bark：可选服务端离线通知
- ntfy：可选服务端离线通知
- 飞书群机器人：可选，支持签名校验
- 企业微信群机器人：可选
- PushPlus：可选，经公众号推送到个人微信

公众产品应升级：

1. Web Push + VAPID
2. 微信订阅消息（若做小程序入口）
3. 通知偏好 / quiet hours
4. delivery retry + dead-letter queue
5. 事件幂等去重

通知中必须包含：

```text
产品 / 容量 / 颜色
门店
检测时间
一键进入 Apple 官方页
```

---

## 13. Catalog Sync

> **v2.3 现状**：只读的对账与漂移检测已实现（`npm run verify:catalog`，见 §2.4）。
> 本节描述的**自动写回**仍未实现——目录依旧是人工维护的快照，脚本只负责在它与 Apple
> 不一致时让 CI 失败，不会自行改写 `catalog.mjs`。自动写回需要人工复核环节，否则
> Apple 的一次页面异常就会污染目录。



长期产品不能手工维护下一代 iPhone SKU。

应建立独立 Catalog Worker：

```text
Apple Buy Page
   ↓
parse variants
   ↓
normalize SKU / capacity / color / price
   ↓
diff against database
   ↓
new / changed / retired
   ↓
contract validation
   ↓
activate
```

任何自动发现的新 SKU 在进入生产监控前，应至少满足：

- 对应明确产品配置
- SKU 格式合法
- Apple 页面可回溯
- 价格/容量/颜色无冲突

---

## 14. 观测与告警

至少监控：

```text
apple_request_success_rate
apple_request_latency_p50/p95/p99
apple_schema_error_count
inventory_unknown_ratio
stale_served_ratio
monitor_cycle_duration
watch_count
stock_transition_count
notification_success_rate
```

最重要的报警不是“服务器挂了”，而是：

> **Apple 请求仍返回 200，但解析出的可信库存突然归零或 SKU 大面积 missing。**

这通常意味着接口契约发生变化。

每天应有真实接口 Contract Test，避免旧 `/fulfillment-messages` 式的静默失效再次发生。

---

## 15. 部署决策

当前单进程版本适合：

- 本地使用
- 小范围自用
- 产品验证
- 单台 VPS

不适合直接作为 Vercel Serverless 常驻监控，因为 `setInterval` 生命周期无法保证。

推荐生产拆分：

```text
Frontend / API    -> Vercel 可行
PostgreSQL        -> managed DB
Redis             -> managed Redis
Monitor Worker    -> 常驻 compute
Notification      -> worker / queue
```

如果希望所有组件尽量简单，第一阶段可直接用一台稳定 VPS：Node API + worker + PostgreSQL + Redis，Cloudflare 放在最外层；用户规模上来后再拆。

---

## 16. 下一阶段

已完成（v2.0–v2.3）：多产品目录、集合覆盖规划、三态熔断与退避、自适应轮询、
按渠道的持久化发件箱、上游契约校验、目录证据链。

仍未做：

1. **门店预约名额**。到店办理走 Apple Store app 的预约系统，各门店名额独立、每天上午放号，
   与手机库存是两份互相独立的稀缺资源。其接口为 App 私有，Web 端不可达，故本项目**不监控**
   名额，也不在 UI 上暗示监控。若要做，需先从 App 侧抓到真实请求。
2. **Web Push（VAPID）**。当前离线推送依赖 Bark / ntfy / 飞书 / 企业微信 / PushPlus，均为全局配置的自用方案。面向公众需标准 Web Push
   或微信订阅消息，并与账号绑定。
3. **多实例部署**。当前状态在单文件 JSON 中，监控为单进程 `setTimeout` 调度。横向扩展需要
   PostgreSQL + Redis（分布式锁选主，避免多个 worker 重复轮询 Apple）。
4. **Catalog 自动写回**（见 §13）。
