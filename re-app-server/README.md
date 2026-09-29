# re-app-server — 官方 app-server(zcode.cjs)逆向工作区

> 目标:把 `zcode.cjs app-server --stdio`(官方 CLI 引擎的 NDJSON 服务模式)从"黑盒"变"白盒"。
>
> 对象:`zcode-unpacked/resources/glm/zcode.cjs`(14,796,911 字节,3.14.1,build cead36fd)。
> 方法:静态偏移提取(snippets/)+ 动态 NDJSON 探针(probe-registry.mjs)+ Zod 自报错 schema 挖掘。

---

## 0. 最终结论:已完全白盒化 ✅(2026-09-29)

**独立拉起的官方 app-server 可以出 token——账号 provider(BigModel Coding Plan)和个人
provider(deepseek)都实测 `generateText` 成功并返回真实 usage。**
复刻命令(探针即最小宿主参考实现):

```bash
PROBE_FULL=1 PROBE_APIKEY_JSON='{"account:bigmodel-individual-coding-plan":"<apiKey>"}' \
  node probe-registry.mjs 4000 account:bigmodel-individual-coding-plan
# => [probe] account:bigmodel-individual-coding-plan => OK text="OK" usage={...}
```

### 0.1 宿主最小协议剧本(白盒配方)

1. **spawn**:`node zcode.cjs app-server --stdio`,环境变量:
   `ZCODE_STORAGE_DIR`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
   (等 `startup/storageState` 到 `phase:"ready"`)。
2. **推送账号配置** `provider/updateAccountConfig`(个人 provider 不需要这步,开箱即用):
   ```jsonc
   {
     "revision": "<任意串>",
     "basedOnZCodeBuiltinRevision": "zcode-builtin:30:<sha256(resolve(builtin目录绝对路径))>",  // ★闸门,见 §2.3
     "providers": { "<account:id>": { "access": { "type": "zhipu-account", "entitled": true } } },
     "states":   { "<account:id>": { "availability": "available", "entitled": true, "current": true } }
   }
   ```
   返回 `{receivedRevision, providerCount, status:"received"}`;内部执行
   `MutableAccountProviderConfigSource.replace()` + `registryService.refresh("host-account-config")`。
3. **应答服务器→客户端请求**(宿主义务):
   - `session/requestRuntimePreferences` → `{nativeSearchEnhancementsEnabled:boolean, memoryEnabled:boolean, askUserQuestionAutoResolutionEnabled:boolean}`(15s 超时,zod 强校验)
   - `interaction/requestProviderRuntimeHeaders` → coding-plan 类:`{headersApplied:true, requestAuth:{apiKey}}`
   - `interaction/requestOfficialMcpAuthHeaders` / `requestPermission` / `requestUserInput` → 合理默认即可
4. **生成** `workspace/generateText`:
   `selection:{providerId, modelId, options:{reasoningLevel}}` + **顶层 `maxOutputTokens`**
   (放 selection.options 里会被 strict schema 拒绝)。
   - 个人 provider 的注册表 ID 是 provider_config.json 里的 **UUID**,不是 providerName!
   - 账号 provider 用目录里的 `account:*` 原名。

### 0.2 为什么插件此前必然失败(三重原因,全部实证)

| # | 原因 | 证据 |
|---|---|---|
| ① | app-server 的注册表运行时 `U = lkt(env)` **只传环境变量**,`t.standalone` 为空 → 不创建 standalone 凭证源;账号 provider 靠**宿主推送**才存在 | snippets/standalone-wiring.js + bundle @14655506 |
| ② | 即使推送,`registryService.refresh` 有**修订号闸门**:`basedOnZCodeBuiltinRevision !== 当前目录修订号` 时**静默丢弃**(无任何错误!) | snippets/refresh-revision-gate.js |
| ③ | 修订号 = `zcode-builtin:<rev>:sha256(resolve(目录文件绝对路径))` —— **对路径字符串哈希**,不是内容哈希;猜内容哈希永远过不了闸门 | snippets/revision-path-hash.js |

### 0.3 顺带破掉的悬案

- **桌面版实际在跑 3.14.3**:桌面日志 revision `e397a7ce…` == sha256(`~/.zcode/v2/runtime/provider/windows-x86_64/3.14.3/endpoint-…/zcode-builtin.json` 的路径)。工作区此前"official-wire 自报 3.14.3 但本机找不到 3.14.3 安装"之谜解开:桌面自更新到了 3.14.3,runtime 目录里那份就是。
- 桌面宿主的喂入剧本(日志实证 11:22:41):`account provider config 已交付到 ZCode agent {providerCount:8, reason:"startup_ready:model_selection_changed"}` → `provider/model 就绪后已启动等待中的 ZCode agent`。

## 0.4 第二轮补充挖掘(同日,全部实测)

**A. 桌面真实交付 payload 全文**(日志 @11:22:41,黄金 ground truth):
- 8 provider 全量推送,`config.access` 仅 `{type, entitled}`(与我们的合成 payload 结构一致)
- 本账号权益画像:`bigmodel-individual-coding-plan` available/entitled/**current**;
  `bigmodel-start-plan` entitled(+`builtinModelIds:["GLM-5.3-Flash"]`);
  **`bigmodel-offpeak-idle-plan` 也是 entitled+available**(桌面侧错峰权益是活的!)
- states 新字段:`unavailableReason:"not-connected"`(zai 系未连接)、
  `connectionKey`(每 provider 的身份绑定哈希,individual=e7226f88…,start=80784cde…)
- revision 即快照序列化:`account:[builtinRev, providers[], states{}]`

**B. 注入后的引擎反馈通道**:
- `state.updated` 通知(scope:session)持续推送:`model.available`(**引擎视角的注册表模型目录**,
  含 providerLabel/contextWindow/maxOutputTokens/reasoning levels/输入模态)、`model.current/lastUsed`、
  `permission.mode`、`thoughtLevel`、会话生命周期(`prompt_started`→`status:"running"`)
- 本账号在引擎目录中只暴露 **GLM-5.3-Flash**(context 200000 / output 128000,
  low|high|max,支持 text/image/video/pdf 输入)——与插件路由自配的 1M context 不同,以引擎为准

**C. `usage/stats`(引擎侧,可直接替代插件 usage 面板)**:
`{range:"7d"}` → totalTokens 1,997,270,495 / cacheHitRate 98.73% / 45 sessions / 268 turns /
4401 toolCalls / avgTTFT 11.3s / favorite GLM-5.3-Flash(94.7% share),source:"agent-db"。

**D. `session/send` 全代理回路(官方 agent 引擎被最小宿主驱动)**:
- `session/send {sessionId, content}` → `{accepted:true, stateRevision}`;随后
  `state.updated(prompt_started→running)`、`computer-use/operation-event`、
  **引擎在回路中多次发起 `interaction/requestProviderRuntimeHeaders`**(任务轮+标题生成等多次模型调用,
  每次由宿主应答 apiKey)
- `session/requestRuntimePreferences` 有两个 scope:`runtime-materialization` 与 `user-execution`
- `session/subscribe` 参数含 `mode: "desktop-continuous" | "web-remote-replayable"`
- `offPeak/list` 在此构建 **Method not found**(方法表有、运行时未注册)

## 0.5 第三轮:引擎出站线格式实抓(最终黑盒揭开)

用 `NODE_OPTIONS=--require .zcode-analysis/wire-hook.cjs` 注入子进程(探针 `PROBE_WIRE=1`),
抓到**宿主喂 key 后引擎真正发出的全部请求**——证据件:`engine-wire.jsonl`(头值已脱敏):

1. **模型调用** `POST https://open.bigmodel.cn/api/anthropic/v1/messages`
   - 头集:`anthropic-version:2023-06-01`、`x-api-key`+`authorization: Bearer`(**双写**)、
     **`x-client-sig`(88ch)+`x-client-pow`(32ch)+`x-client-nonce`+`x-client-ts`**
     ——独立拉起的引擎**依然完整执行 V4 客户端签名与 PoW**(密钥材料来自宿主喂的 apiKey)
   - 其余:`x-device-mid`、`x-app-id:zcode`、`x-zcode-agent:glm`、`x-zcode-session-type`、
     `x-title:Z Code@electron`、UA `ZCode/3.14.4 ai/6.0.193 ai-sdk/provider-utils/4.0.27`
   - body:anthropic messages 格式;`metadata.user_id={"device_id":…,"account_uuid":"","session_id":…}`;
     请求顶层 `maxOutputTokens` → 线上 `max_tokens`
2. **模型调用前的预握手** `POST /api/paas/c1f3a7e2/v2/client` `{apiKey,nonce,sig,ts}`
   ——客户端注册/证明(sub-b 文档 `createCodingPlanApiKeyResolver` 的实机确认)
3. **版本三层真相**:桌面 main 3.14.3、安装包 3.14.1、**`glm/zcode.cjs` 引擎自报 3.14.4**
   (引擎独立版本号;MCP 客户端 0.16.9)。official-wire 的版本对齐策略应以此为准。
4. 附带抓到:`GET zcode.z.ai/api/v1/agent/configs`(远程配置,x-api-key 鉴权)、
   MCP `image_search` 的 discover/initialize(即使宿主应答空 auth 也会探测)。

**offPeak 方向反转(重要)**:`offPeak/create|list` 是**引擎→宿主**的 `requestClient`
(引擎把错峰任务委托给宿主实现,桌面 main 才是票据客户端——与 `.debug/ticket-client.txt` 互证)。
客户端直接调用会 Method not found;要白盒错峰,宿主需实现这两个 handler(schema:`IGt`/`lYe`)。

**MITM 备注**:模型代理走 config `network.httpProxy/caCertFile`(env `ZCODE_HTTP_PROXY` 仅次优先,
CA **不**吃 `ZCODE_AGENT_CA_CERT`——那只进工具子进程环境);TLS 校验失败会被归一化为
`MODEL_TLS_VALIDATION_FAILED`。进程内 wire-hook 是更干净的路(本轮采用)。

## 0.6 Start Plan(GLM-5.3-Flash)最终结论:能用,但只认 agent 主回合

**实测成功**(session/send 全代理回路,真实 usage):
`finish:"stop"`,tokens `{input:15410, output:3, cacheRead:15360}`——
15410 输入 = 官方三段 system(42+1211+5466 字符)+ 22 个官方工具;输出即"OK"。

### 三层拦截语义(判别实验矩阵,全部实测)

| 请求形态 | x-zcode-session-type | start-plan 结果 | 说明 |
|---|---|---|---|
| 垃圾 key | — | `Provider authentication failed` | 鉴权层 |
| 裸 generateText / 带 3 段官方 system 的 generateText | `other` | `blocked due to unusual activity` | **风控:start-plan 不接受工具性调用** |
| session/send agent 主回合 | **`main`** | ✅ 成功生成 | 唯一放行形态 |
| agent 主回合(桌面占并发时) | `main` | `429 3008 user concurrency limit exceeded` | 瞬态并发上限,槽释放即成功 |

关键修正(推翻早前两轮的假设):
- **9/15 的 204 字符 JWT 一直有效**(桌面与我们的成功请求用的同一把钥匙);"需要重新登录"不成立;
- "unusual activity" 与提示词无关(generateText 带官方 3 段 system 仍被拦)——
  判别变量是 `x-zcode-session-type` 头(agent 主回合=main,工具调用=other),
  引擎按 querySource/operation 自动设置;
- 3008 为瞬态(桌面正在占用 start-plan 并发槽时),稍候重试即过。

### 出站请求形态(agent 主回合,线抓包实证)
- 端点 `POST zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`
- `x-api-key`+`Bearer` 双写 JWT;无 V4 签名/PoW(start-plan 是 JWT 通道)
- body:`system` 三段、`tools` 22 个、`max_tokens:128000`、`metadata.user_id`(account_uuid 可空)
- 官方 system 三段已存 `official-system-blocks.json`(42/1211/5466 字符,3.14.4 引擎版)

### 对 DSH 的落地判定
Start Plan 路由**必须走 session/send 模式**(插件 transport 移植时,generateText 只适用于
coding-plan;start-plan 需要引擎的 agent 会话上下文)。429/3008 应按"并发占用可重试"处理。
带提示词覆写时除外——插件 2.5.32+ 会旁路引擎走直连,见 0.7 的前缀门与等效覆写。

## 0.7 第四轮:start-plan 系统提示词前缀门 + 等效覆写(同日,DSH UI 全链路实测)

在 0.6 的 session-type 风控之上,**start-plan 还有第二道门:system 前缀校验**(与 off-peak
3012 门同族)。全部实测(裸探针 + DSH 真实回合):

| system 形态 | 结果 | 证据场景 |
|---|---|---|
| 缺失 system 字段 | `3012 unusual activity` | 裸探针(20:01) |
| 官方①②被替换(真覆写) | `HTTP 405 unusual activity` | DSH turn(19:40) |
| 官方①② + ③之后的任意块(追加/runtime 覆写/规则更新声明) | ✅ 放行 | POST88(18:43)、RT77(19:45)、规则更新声明(19:57) |
| 官方①②③ 原文 | ✅ 放行 | 全部基线回合 |

**结论:门只逐字校验块①(身份句)与块②(agent 主提示词)的前缀;块③及之后的块数量与内容
完全自由。** coding-plan(`open.bigmodel.cn`)无此门,且实测接受未签名请求(仅
`x-api-key`/`Authorization` 即 200)。

### 服务端 token 账本(覆写生效的不可伪造证据)

| system 构成 | input tokens | 通道/链路 |
|---|---|---|
| 官方三块(基线) | 19077 | start-plan 引擎委托 |
| ①②官方 + runtime 覆写 | 10015 | start-plan 直连 |
| 三层全部短覆写 | 9592 | coding-plan 直连 |
| 三层全清(0 字节,省略 system) | 9490 | coding-plan 直连 |
| ①②兼容前缀 + 规则更新声明(等效覆写) | 9579 | start-plan 直连 |

地板 ≈9.5K = DSH 用户内容(runtime context/skill 提醒)+ 22 工具清单;官方三段 system
本身 ≈9.5K token(其中 runtime 块占 ≈9.1K)。

### 覆写声明的模型遵循度(措辞对照)

同一块结构(官方①②③ + 声明块要求回复以 OW99 开头),4 种声明措辞 × coding-plan 端点:
**4/4 模型遵循**。但 19:57 全 DSH 上下文 + 旧措辞(`[SYSTEM OVERRIDE — supersedes ALL…]`)
出现一次不遵循——模型思考原文把它判为 "suspicious instructions … claiming to be
overrides"(注入检测)。落地措辞因此定为 **`Rule update (operator configuration)`** 框架:
挂接官方 runtime 块自己声明的 "mid-conversation system 可更新规则" 条款,模型会给出
原则性遵循理由("operator has replaced … takes precedence")而非触发注入怀疑。

### 其他门事实

- `1005 exceed quota limit`:Start Plan 信任窗额度耗尽(面板 `zcode-v3-start-plan-trust-*`,
  100M/100M;重置时间见权益面板,本例次日 00:00)。
- 引擎委托链路的 usage 含 cacheRead(1536/12800 等);直连 wire 通常 cacheRead 0——
  可作为链路判定特征。

### 落地(插件 2.5.32–2.5.34)

`systemBlocksForChannel`:无门通道真覆写(逐块替换/移除,0 块省略 system);有门通道
(start-plan/off-peak)等效覆写 = 官方①②兼容前缀(≈0.6K token)+ runtime 槽照常覆写/清空 +
identity/agent 覆写与清空装进规则更新声明块。

## 1. 已确证事实链(F1–F14)

| # | 事实 | 证据 |
|---|---|---|
| F1 | builtin 目录(8 个 `account:*`)在打包版与全部 runtime 刷新版一致 | §5 对比 |
| F2 | 凭证库 `enc:v1:` 用官方回退密钥可解(SHA256(`zcode-credential-fallback:{platform}:{homedir}:{user}`));`ZCODE_CREDENTIAL_SECRET` 优先 | fix-credential-reencrypt.mjs |
| F3 | standalone entitled 门控:identity(明文)+ api-key(加密)两条同时可读才 true | snippets/account-gating.js |
| F5 | `app-server` argv → standalone 检测为真,但协议引导仍不给 registry 传 standalone 选项 | snippets/standalone-detection.js + @14655506 |
| F6 | 裸 spawn 下 generate 查无一切 provider(账号+个人)→ 实为 ID 用法问题 + 账号未推送 | probe 输出 |
| F7 | `provider/updateAccountConfig` schema 全量推出(zod 逐字段);`{received,providerCount:8}` | probe |
| F9 | 启动即请求 `interaction/requestOfficialMcpAuthHeaders`(z.ai JWT)等 5 类宿主交互 | probe 通知流 |
| F11 | builtin 目录 CDN 刷新:`zcode-builtin-refresh.json`(leaseUntil/nextEligibleAt) | 目录列举 |
| F12 | **个人 provider 开箱即用**:UUID+正确 modelId 直接 generateText 成功(无需任何注入) | probe: `718647ce-…\|deepseek-v4-flash => OK` |
| F13 | **账号 provider 在修订号对齐后 generateText 成功**(Coding Plan,真实 usage) | probe: `account:bigmodel-individual-coding-plan => OK` |
| F14 | `maxOutputTokens` 为请求顶层字段;`selection.options` 只认 `reasoningLevel` | probe zod 试错 |

## 2. 关键机制细节

### 2.1 注册表三源合流(ProviderRegistryService)
`refresh()` 每次读 **config 源**(builtin 目录+personal 目录)与 **account 源**(宿主推送或
standalone 凭证),过修订号闸门后交 `#n.resolve(...)` 合并出 `registryProviders`,
`CKe(ProviderRegistry)` 重建。generate 走 `ApiProviderModelRuntime.modelFactory` →
`registry.validateSelection/getProvider/getModel` → `modelAdapter.createModel`。

### 2.2 fail-closed 语义
builtin 目录里 `access.type==="zhipu-account"` 的 provider 初始快照一律
`entitled:false`(createFailClosedAccountProviderConfigSnapshot);仅宿主推送或 standalone
凭证可翻转。个人 provider(api-key 型)无此门。

### 2.3 修订号闸门(本次最难啃的一步)
```
revision = `zcode-builtin:${catalogRevision}:` + sha256( resolve(activeCatalogFilePath) )
```
- 哈希对象是 **path.resolve 后的绝对路径字符串**(Windows 反斜杠形态)
- 桌面(3.14.3 runtime 目录)= `zcode-builtin:30:e397a7ce…`
- 本探针 env 指向打包文件 = `zcode-builtin:30:50f3b71f…`
- 闸门不匹配时 refresh **静默保留旧快照**——没有错误、没有日志,这是"注入被接受但无效"的元凶

### 2.4 凭证与登录态
- 凭证库:`~/.zcode/v2/credentials.json`(enc:v1 AES-256-GCM,回退密钥三端一致)
- OAuth 已于 9/21 过期(`credentials.json.bak-expired-oauth`)——但**白盒配方不需要 OAuth**:
  账号鉴权走宿主应答的 `requestProviderRuntimeHeaders`(直接给 api-key),凭证库只影响
  standalone CLI 自己的 entitled 判定,不影响宿主推送路径。

## 3. 对 zcode-provider 插件的移植指南(下一步)

`OpenZCodeAppServerTransport` 需要补三块即可真正可用:
1. spawn 后、首个请求前:计算 `BUILTIN_REV = zcode-builtin:30:sha256(resolve(cliPath同目录的builtin目录))`,
   推送 `provider/updateAccountConfig`(providers/states 由路由的 family+mode 派生)。
2. `handleServerRequest` 增加应答:`session/requestRuntimePreferences`(默认值即可)。
   `requestProviderRuntimeHeaders` 已有(补上 coding-plan 的 apiKey 来源)。
3. generate 请求补顶层 `maxOutputTokens`(取 route 的 output limit)。
风险点:修订号跟随 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的实际值;若未来官方把哈希改成
内容哈希,闸门公式需重推(snippets/revision-path-hash.js 有定位锚点)。

## 4. 曾列为开放、现已闭合的问题

- ~~Q1 generate 期注册表来源~~ → `lkt(env)` 无 standalone 参数(§0.2①)
- ~~Q2 注入后如何生效~~ → 修订号闸门(§2.3)
- ~~Q4 桌面怎么喂引擎~~ → 桌面日志三段剧本 + `provider/updateAccountConfig` 通道(§0.3)
- Q3(官方重新 login)已**不需要**:白盒配方绕开登录态。

## 5. 文件索引

| 文件 | 说明 |
|---|---|
| `snippets/*.js` | 13 个带偏移头的提取件(★ = 本次闭合关键) |
| `extract-snippets.py` | 重新生成 snippets |
| `probe-registry.mjs` | **最小宿主参考实现**:通知流/注入(修订号自动计算)/应答/生成/usage/stats/session-send 全代理回路(开关:`PROBE_FULL/PROBE_APIKEY_JSON/PROBE_USAGE/PROBE_OFFPEAK/PROBE_SEND/PROBE_SETTLE_MS`) |
| `probe-prompt-gate.mjs` | **系统提示词前缀门探针(§0.7)**:门矩阵(no-system/replaced-12/full)+ 覆写声明措辞遵循度(A–D 四框架),coding-plan 未签名直通 / start-plan JWT 通道 |
| `fix-credential-reencrypt.mjs` | 凭证重加密工具(实测无需,留档) |
| `../.debug/openzcode-app-server-smoke*.mjs` | 历史 smoke |

```bash
# 一键复验(个人 provider,无需任何 key 注入)
node probe-registry.mjs 4000 "718647ce-20a7-47c5-b94b-3cdfb6b06a6f|deepseek-v4-flash"
# 账号 provider(Coding Plan)
PROBE_FULL=1 PROBE_APIKEY_JSON='{...}' node probe-registry.mjs 4000 account:bigmodel-individual-coding-plan
```

与既有资产关系:`.zcode-analysis/sub-b/cli-wire.md` 的 provider 命名/强制头结论不变;
本区新增 fail-closed 语义、宿主协议剧本、修订号闸门与路径哈希公式、桌面 3.14.3 实证。
