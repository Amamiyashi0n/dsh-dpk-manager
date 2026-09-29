# zcode-provider 插件深度分析

> **⚠️ 状态更新(2026-09-29 晚)**:本文是 **2.5.26 时代的实测快照**,以下结论已过时——
> 版本现为 **2.5.34**;MSYS2 nodePath 已废除(统一传统 Node);start-plan/off-peak 无覆写时
> 走引擎会话委托(session/send 流式+60K 历史预算),coding-plan 及一切带覆写请求走直连 wire;
> 后置提示词层已是**逐块覆写**语义(清空=0 字节移除),start-plan 前缀门以官方①②兼容前缀+
> 规则更新声明等效覆写。现行事实以 `dsh-plugin-zcode-provider/README.md` 与
> `re-app-server/README.md`(§0.7 前缀门)为准;本文其余内容作为历史分析保留。

对象：`dsh-plugin-zcode-provider`（`zcode-provider@2.5.26`，MIT，白盒 ZCode-compatible DSH 插件）
分析方式：源码逐文件通读 + 安装态/运行态实测 + 三路并行深挖（wire/凭证、权益/用量/错峰、验证码/app-server/客户端/打包）+ DPK 校验。
标注约定：**✅ 实测**（本次命令/文件直接验证）｜**📄 代码实证**（读到具体行）｜**🔍 推断**。

---

## 1. 部署现状（✅ 全部实测）

| 项 | 结果 |
|---|---|
| 版本 | `2.5.26`，`private`，MIT，`type: module`，`main=lib/index.js` |
| 安装位置 | `~/.dsh/dpk/store/a730a5fc…/package` → profile `web` 以 `link:` 引用 |
| 归档 | `dpk/zcode-provider/zcode-provider-2.5.26.dpk`，`dpk verify` 通过：81 条目 / 80 文件 sha256 全对 / digest 与安装记录一致 |
| **安装态 == 工作区源码** | 5/5 文件 sha256 相同（`lib/index.js`、`src/index.ts`、`lib/official-wire.js`、`cordis.patch.yml`、`client.js`）→ **本目录就是线上运行的那份代码** |
| 运行态 | 正在运行的 DSH Web（`127.0.0.1:51080`，PID 9088）加载了本 profile；插件注册的 `zcode_usage` 工具在本会话可用 |
| 当前鉴权链路 | `~/.dsh/zcode-provider/auth-backend.json` = `openzcode-app-server` |
| 当前 appServer 配置 | profile patch 里显式 `enabled: true`、`cliPath=zcode-unpacked/resources/glm/zcode.cjs`、`nodePath=msys64/clang64/bin/node.exe` |
| 提示词覆盖 | `prompt-overrides.json` = `{}`（无自定义层）→ **不触发 app-server 旁路** |

结论见 §5 的 P0-1：**当前配置下，账号类路由的模型请求实际是交给官方 CLI 子进程执行的**，不是走插件自己的直连白盒线路。

---

## 2. 包结构与对外契约

- `exports`：15 个子路径（`official-wire / credentials / usage / entitlements / usage-remote / captcha / captcha-remote / offpeak / official-prompt / openzcode-app-server / auth-backend / storage` + `./client` + `./locale/*.json` + `./package.json`）。
- `dsh` 清单：`manifestVersion: 1`，`bundle.patch: cordis.patch.yml`，`client.inject` 5 个 DSH 包、`platform: web`、`immediately: true`。
- `peerDependencies`：`cordis`、`cordis-plugin-loader`(optional)、`dsh-client-ui-primitives`、`dsh-client-ui-settings`、`dsh-llm`、`schemastery`、`react`。
- `files` 主动收录 `src/`、`tests/`、`tsconfig.json`（可审计，README 说明是有意为之）。DPK 内**确认没有** `credentials.json` / `providers.json` / `telemetry-state.json`，测试 fixture 全为合成值（`fixture-…`、identity `44000000000000000`）——"凭证不进包"这条为真。
- 两处小瑕疵：`lib/prompt-remote.js`、`lib/prompt-storage.js` 会随包发布但 **`exports` 里没有对应子路径**；`"./client"` 只有 `default` 没有 `types`，TS 消费者解析不到类型。

---

## 3. 模块地图

| 模块 | 行数 | 职责 |
|---|---|---|
| `src/index.ts` | 1677 | 插件主体：配置 schema、路由派生与设置层同步、DSH→Anthropic 转换、出站请求、SSE→DSH 翻译、`zcode_usage` 工具、4 个 Remote、adapter 注册 |
| `src/official-wire.ts` | 408 | 归因头/请求头/客户端签名（门闩→握手→HKDF+HMAC→Ed25519+GCM 取私钥→PoW） |
| `src/official-prompt.ts` | 101 | 官方三段 system prompt 逐字常量（42 + 2313 + 5451 字符）+ `{{CWD}}` 等占位符渲染 |
| `src/credentials.ts` | 181 | `enc:v1:` AES-256-GCM 凭证解密、账号/套餐密钥解析 |
| `src/usage.ts` | 901 | 6 个权益/用量端点调用与归一化 |
| `src/entitlements.ts` | 676 | 权益域模型、套餐判定、last-known-good 归并 |
| `src/usage-remote.ts` | 133 | `zcodeEntitlements` Remote（面板数据） |
| `src/offpeak.ts` | 597 | 错峰票据协议（取号→轮询→派发→结算） |
| `src/captcha.ts` | 338 | 业务码 3007 判定、SDK 配置、一次性 param |
| `src/captcha-remote.ts` | 473 | `zcodeCaptcha` Remote + 挑战队列 broker |
| `src/openzcode-app-server.ts` | 740 | 拉起官方 CLI 的 `app-server --stdio`，NDJSON 协议 |
| `src/auth-backend.ts` | 118 | 鉴权链路选择持久化 + `zcodeAuthBackend` Remote |
| `src/prompt-*.ts` / `src/storage.ts` | 61/99/30 | 提示词覆盖持久化/Remote、插件自有路径 |
| `client.js` | 1530 | Web 端：权益面板页 + 侧栏图标 + 全局验证码浮层 + 插件配置页（提示词编辑器/鉴权开关） |
| `tests/` | 19 个 `.mjs` | 约 **677** 行断言 |

---

## 4. 运行期行为

### 4.1 激活（`apply()`，index.ts:1292-1677）
1. 取设置命名空间 `ctx.fiber.entry.options.id`。
2. 规范化并**无条件写盘** `auth-backend.json`、`prompt-overrides.json`；若设置层还留着旧版 `promptOverrides`，迁移到文件并 `settings.mutate` unset 旧字段。
3. `routes` 从设置层读取 → 删除所有 `openai`/`openai-compatible` 路由（幂等，顺带清历史垃圾）→ 用 `providers.json` 派生路由**覆盖**同名条目（family/access/credential/baseURL/apiKey/display/models 任一不同即覆盖），差异通过 `settings.mutate(ns, [{set,…},{unset,…}])` 回写。
4. 构造 `profileOf()`（版本/来源标识/渠道/平台/OS/语言/时区/**deviceMid**）、`ClientRequestSigner`、`OpenZCodeAppServerTransport`、`WebCaptchaBroker`；`ctx.effect` 注册清理。
5. 两个 15 s 缓存 + 核心 4 s / 补充 8 s 超时；`registerUsageTool` 用 `ctx.inject(['tools'])`（而非 `ctx.get`）；注册 4 个 Remote：`zcodeEntitlements`、`zcodeCaptcha`、`zcodePrompts`、`zcodeAuthBackend`。
6. 逐路由 `ctx.llm.registerAdapter([route], adapter)` + `registerConfigurableProviders`。

⚠️ 注释与实现不一致两处：① "已存在的保留用户改动"，但第 3 步的比较包含 `baseURL/apiKey/models`，**用户在设置页对派生路由的改动每次激活都会被文件值覆盖**；② index.ts:1400 注释称"激活后预热核心权益"，**代码里没有任何预热调用**。

### 4.2 一次模型请求的两条路径
```
streamGen()
├─ authBackend==='openzcode-app-server' && appServer && conn.family && 无自定义提示词层
│    └─ OpenZCodeAppServerTransport.generate()  ← 拉起官方 zcode.cjs 子进程（NDJSON）
└─ 否则（或上面条件不满足）
     ├─ DSH 历史 → Anthropic messages（丢弃 system；悬空 tool_use 补占位 tool_result；
     │   同轮多 tool_result 合并且保证 tool_use 紧邻语义）
     ├─ system = 官方三段（+可选用户附加层，placement=before 时插在第 2、3 块之间）
     ├─ body：model / max_tokens / metadata.user_id / system / messages / tools / stream / thinking / output_config.effort
     ├─ headers：源码头 + 请求头（x-request-id/x-query-id/x-zcode-trace-id/…）+ anthropic 头（x-api-key 与 Bearer 双写）
     ├─ 签名（仅 requiresClientSigning 为真时）：gate → 握手 → Ed25519 → X-Client-*
     ├─ 401 且 reason∈{VERIFY_SIGNATURE_INVALID, VERIFY_APIKEY_EXPIRED} → 重新握手重试 → 再拒则 enterBypass 改发未签名
     └─ 3007 且 start-plan/off-peak → 解一次验证码 → 带 param 重试一次；解不出则原样返回 3007
```
SSE 翻译对齐官方：`content_block_start/delta/stop` → `block-start/text-delta/reasoning-delta/tool-call-delta/block-end`；`message_delta.stop_reason` → `stop|tool-calls|max-tokens`；校验重复 index、未闭合块、缺 `message_start`、缺 `message_stop`。

### 4.3 权益/用量
- 端点：`open.bigmodel.cn/api/monitor/usage/quota/limit`、`/api/biz/subscription/list`、`/api/monitor/usage/model-usage`；`zcode.z.ai/api/v1/zcode-plan/billing/balance`、`/api/v1/mcp/usage`；均带 `x-device-mid` **仅当 URL 以配置的 endpointOrigin 为前缀**。
- 判定：订阅列表为权威；`inCurrentPeriod===true && status==='VALID'` 才算 active；配额/订阅接受 `code∈{0,200}`，Start Plan 与 MCP **严格要求 `code===0`**。
- last-known-good：仅当本轮 `unknown` 才保留上一轮；要求 `accountType+mode` 相同且 `connectionKey` 相等**或任一侧缺失**（这个"缺失即同账号"是潜在 fail-open）；一旦本轮判定 `unavailable` 或 `pending` 就会**撤下**已确认权益。
- 状态只在 `index.ts` 闭包内存里（`entitlementCache`/`lastEntitlementReport`），重载即丢失。

### 4.4 错峰（当前禁用，协议完整保留）
- 协议：`GET /off-peak/ticket/availability`、`POST /ticket`、`POST /ticket/status`（客户端上限 100）、`POST /ticket/<id>/settle`；状态机 `queued→ready→active→settled`。
- 失败码映射：3012=缺官方提示词(attestation)、3103=取号超限、3104=票无效、3102/3001=票过期、3105/429=排队重试。
- **三层禁用**：① `OFF_PEAK_ENABLED_DEFAULT=false` 且 `runtimeProviders()` 对 `-offpeak-idle-plan` 返回 `[]`（且没有任何配置开关能打开）；② `usage.ts` 的 `appendOffPeakReport` 需要 `deps.offPeakReport===true`，而 `usageDeps` 从不设置它；③ 取号/轮询/结算/派发鉴权函数**没有任何生产调用**，只有测试引用。
- 恢复路径：翻开关 + 传 `offPeakReport:true` + 把 `acquireOffPeakDispatch`/settle 接进 adapter。

---

## 5. 发现清单（按影响排序）

### P0
1. **默认走 app-server，即"启动官方 ZCode 主程序"，与 README 声明冲突（✅+📄）**
   README:3/58 写"运行时不启动、加载或调用 ZCode 主程序""不会把 ZCode 可执行文件作为运行时依赖"；但 `Config.appServer` 的 schema 默认是 `{enabled: true, …}`（index.ts:1190-1194），`readAuthBackend` 默认 `'openzcode-app-server'`（auth-backend.ts:30），而 `streamGen` 在 `authBackend==='openzcode-app-server' && appServer && conn.family && 无自定义提示词层` 时**用子进程结果直接替代白盒直连**（index.ts:795-804）。
   本机实测三条全部命中：auth-backend.json=openzcode-app-server、profile 显式 enabled:true + cliPath、prompt-overrides 为空 → **当前账号类请求由官方 `zcode.cjs` 执行**。包内自己的边界测试也承认这一点：`standalone-package.mjs` 把 `src/`/`lib/`/`client.js` 里的 `zcode.cjs`、`app-server` 等 token 列为禁止项，但显式豁免 app-server 模块，注释写"The comparison transport is the sole explicit integration boundary… may name and launch the configured ZCode CLI"。
   附带后果：若 `cliPath` 未配置（如 `DSH_ZCODE_REPO`/`DSH_ZCODE_CLI_PATH` 都缺），`ensureStarted` 直接抛 `CONFIGURATION`，**不会回退到白盒直连**。
2. **签名请求同时发 `x-session-id` 与 `X-Session-Id`（📄+🔍）**
   基础头用小写 `x-session-id`（index.ts:762），签名头用大写 `X-Session-Id`（official-wire.ts:402）。fetch/undici 的 `Headers` 大小写不敏感 → 实测（子代理在内存里构造 Request）合并成 `x-session-id: <id>, <id>`。若服务端按会话 id 做绑定/签名校验，每个签名请求都会走"两次被拒→永久 bypass"的降级链。**这是最值得用抓包做一次实机确认的项**（测试用的 stub fetch 会把键小写化并 `Object.fromEntries`，因此看不见）。

### P1
3. **SSE `error` 分支不可达（✅ 我逐行确认 src 与已发布 lib）**
   `lib/index.js:825` 先做白名单 `['content_block_start',…,'message_stop']` 过滤并 `continue`，`828` 行才判 `event.type === 'error'` → **永不执行**。后果：服务端在流中返回 `error` 帧时被静默丢弃，最终以 `STREAM_CLOSED`（"ended before message_stop"）报出，丢失真实错误信息。
4. **凭证明文进入 DSH 设置层（✅+📄）**
   路由对象含 `apiKey` 并经 `settings.mutate` 回写（index.ts:1337-1352）。本机 `~/.dsh/profiles/web/cordis.patch.yml` 里就能看到 BigModel Coding Plan key、Start Plan JWT、以及第三方 key 的明文；插件自有文件是 `0600`，设置层不是。
5. **验证码触发判定过于宽松（📄）**
   3007 用无锚点正则 `/"code"\s*:\s*"?(\d+)"?/` 在**整个响应文本**上抓第一个 `code`（captcha.ts:145-148），且不看 HTTP 状态 → 任何 200 响应体里出现 `"code":"3007"` 都会被当成挑战，触发一次完整请求重发（重发只做一次，解不出则 fail-open 返回原响应）。
6. **代码/注释不一致与死接线**
   - 注释称"保留用户改动"，实际每次激活覆盖派生路由的 baseURL/apiKey/models。
   - 注释称"激活后预热核心权益"，无预热代码。
   - `officialSystemBlocks` 默认参数是已禁用的 off-peak provider/model（index.ts:547-548）。
   - `usage.ts` 模块头文档写 `billing/current`，代码/测试用 `billing/balance`。
   - `usage.mjs` 的 `--live` 段仍在断言已删除的顶层字段（`live.limits`/`live.subscription`/`live.startPlan`/`live.startPlanBalance`）→ 一跑就 TypeError。
   - `storage.mjs` 有两个断言读的是不存在的文件，恒真（空断言）。

### P2（稳健性/卫生）
7. **数据目录残留 ~40 MB（✅）**：`~/.dsh/zcode-provider/captcha-profile/` 是一整套 Chromium user-data（Cookies、Login Data、8×4 MB BrowserMetrics…），`backups/credentials.pre-2.3.0.json`、`credentials.pre-2.4.0.json`、`dpk-index.pre-2.3.0.json`、`web-cordis.patch.pre-2.3.0.yml`。而 **当前 src/tests 里搜不到 `captcha-profile`/`playwright`/`backups`/`pre-2.3.0` 任何引用** → 早期版本"自己开浏览器解验证码 + 改 profile patch"的遗留，现已改为纯 Remote 承载，可清理。
8. **版本口径漂移（✅）**：代码把客户端版本钉在 **3.14.3**（fixture 也确认抓的是 3.14.3），但工作区保留的官方产物是 **3.14.1**（build `cead36fd`），本机没有 3.14.3 安装。UA 后缀 `runtime/node.js/24` 是硬编码，可能与真实运行时矛盾。
9. **单位/时间语义不统一（📄）**：同一个 `percentage` 字段有三种含义（厂商百分比 / `remaining/total` 小数 / MCP 的百分比）；`unit` 对大模型是枚举、对 Start Plan 被填成 `total_units` 又当作分母渲染；`effectiveAt` 是**秒**而同类时间戳是毫秒；MCP 缺 `server_time` 时 `serverTime` 变成 `0`（1970）。
10. **静默失败面**：凭证不是 `<id>.<secret>` 形态时 `signHeaders` **不打日志**直接发未签名；凭证库读取把一切异常映射为 `{}`（截断 == 未登录）；MCP 用量失败完全吞掉（"坏掉的 MCP 平面"与"没有 MCP 额度"无法区分）。
11. **缓存作用域**：`#gateSnapshot` 无 key 且 signer 全路由共享 → 某一路由的门闩结果会被其他 host 复用 1 小时；`#privateKey` 不过期；`enterBypass()` 永久且进程级。
12. **平台假设**：凭证解密密钥种子硬编码 `win32`（credentials.ts:25）；app-server 默认路径按 MSYS2 clang64 布局推导，非 Windows 上只会往 PATH 里塞无效项。
13. **app-server 进程管理**：只 `child.kill()`（无进程树/Job 对象）、无 stdout 上限（单条超长行会无限增长 buffer）、无请求级超时、临时目录里的 `provider_config.json`（含明文 apiKey）仅在 `dispose()` 时删除。
14. **测试面**：亮点是真实 Cordis Loader 组合 + HMR 拆卸、把 `.dpk` 边界做成可执行断言、SSE/wire 用 stub fetch 做逐字段对拍。缺口：从不打真实网关；gate/handshake 的失败分支、TTL 过期、`requiresClientSigning` 矩阵、index.ts 的两级缓存与 pending 复用、app-server 崩溃/取消、`captchaEnabled:false` 端到端 均无测试。

---

## 6. 总体评价

**做得好的**：协议实现是"可审计的白盒"——常量、header 集合、签名消息格式、票据状态机都集中且带出处注释；与官方对齐的 fail-open 语义（签名不可用就发未签名、验证码解不出就返回原错误）与官方一致；边界测试（无二进制、无机器路径、无浏览器自动化）是同类插件里少见的工程化程度；`ctx.inject(['tools'])`、`ctx.effect` 清理、Remote 只暴露规范化快照而非凭证，都符合 DSH 惯例。

**主要问题**：① 文档承诺与实际默认行为冲突（app-server 默认开启，会拉起官方 CLI）；② 用 DSH 设置层承载明文凭证；③ SSE error 死分支与重复 `x-session-id` 这类"看得见但没测到"的缺陷；④ 权益/用量域对厂商字段的假设密集且失败时倾向 fail-open，厂商改字段会**静默**变成"仍然有权益"。

**建议优先级**
1. 实测签名请求的重复 `x-session-id` 是否被拒（一次带 dump 的代理即可定论）。
2. 修 `translateZcodeEvents` 白名单顺序，让 `error` 帧可达（同时补一条测试）。
3. 把 `apiKey` 从设置层回写中剥离（改存引用/句柄），或明确设置层为受保护存储。
4. 让 README 与默认值一致：要么把 `appServer.enabled` 默认改为 `false`，要么在 README 首段说明"默认经官方 CLI app-server 转发，白盒直连需切换到 `closezcode-app-server`"。
5. 清理 `captcha-profile/`、`backups/`，并修掉 `usage.mjs --live` 陈旧断言与 `storage.mjs` 空断言。
6. 统一 `percentage`/`unit`/时间戳单位约定（建议在 entitlements 层就归一化成同一语义后再外发）。
