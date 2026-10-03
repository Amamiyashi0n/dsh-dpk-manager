# zcode-provider

zcode-provider 是一个可独立打包为 DPK 的 DSH bundle。它在包内以可读 TypeScript/JavaScript 完整实现 ZCode-compatible 的模型协议和账号权益接入，运行时不启动、加载或调用 ZCode 主程序。

## 架构边界

~~~text
DSH UI / history / tools / agent loop
  -> zcode-provider (white-box adapter)
  -> Anthropic-compatible HTTP + ZCode headers/signing/captcha
  -> BigModel / Z.ai endpoints
~~~

DSH 负责：

- 会话历史和消息生命周期
- 工具注册、工具结果和 Agent Loop
- 附件持久化与图像读取
- provider 配置页和流式 UI

本插件负责：

- 官方三段 system prompt 的逐字投影
- Anthropic messages/tools 请求转换
- SSE 文本、推理和 tool-call 事件转换
- ZCode-compatible 归因头、会话标识、客户端签名和验证码重试
- Coding Plan、Start Plan 凭证解析以及权益/用量查询
- 账号权益 last-known-good 状态机；短暂网络异常不会撤下已确认的模型或权益
- 套餐路由按插件配置同步发布；权益网络请求只更新账号事实，不阻塞或重排模型 Registry

provider 配置、凭证和设备标识全部属于插件，存放在 dpk 受管数据卷 `~/.dsh/data/@local/zcode-provider`（见 dpk-manager SPEC §13）。这些文件缺失时插件仍会正常激活，并可完全通过自身 `routes` 配置运行。

**2.6.0 破坏式数据迁移**：旧根 `~/.dsh/zcode-provider` **不再被读取**。安装 2.6.x 后：

- `config/providers.json`、`config/prompt-overrides.json` 由 dpk 安装期从包内种子物化；
- `state/credentials.json` 等凭证**不迁移**（加密密钥绑定用户与主目录，拷过去也解不开）——在新机器上重新登录官方 ZCode，或用 dpk 的 config 导出/导入搬运 `providers.json`；
- 需要保留旧 `providers.json` 的，手动复制到 `~/.dsh/data/@local/zcode-provider/config/providers.json` 即可（它会按"用户改过"收编，后续升级永不覆盖）；
- 旧目录确认无残留价值后可整目录删除。

DPK 的 `cordis.patch.yml` 会自行注册插件。profile 只需要把 `zcode-provider` DPK 列入 bundles，不需要再复制路由、提示词或协议配置；账号数据也不会写入 DPK。

## 实际运行行为

插件是运行在 DSH Host 内的适配层，实际流程如下：

1. **激活时**：读取插件目录下的 `providers.json`、加密的 `credentials.json` 和 `telemetry-state.json`，解密并派生模型路由，然后注册 LLM adapter、provider、`zcode_usage` 工具和 `zcodeEntitlements` Remote。
2. **路由同步时**：把插件路由同步到 DSH settings，并清理 `openai` / `openai-compatible` 路由。同步动作由 DSH settings 服务执行，路由对象可能包含解密后的 `apiKey`；这与“凭证不写入 DPK 包”是两件事。
3. **发送模型请求时**：按通道分路。`start-plan` / `off-peak` 且无提示词覆写时走**引擎会话委托**（spawn 官方 `zcode.cjs app-server --stdio`，session/create→setModel→send→轮询 messages，流式吐增量，历史按 60K token 预算截断）；`coding-plan` 或带覆写时走**直连 wire**：把 DSH 历史、工具、工具结果和图片转换为 Anthropic `/v1/messages` 请求，丢弃上层原始 system 消息，注入插件装配的 system 块（见下「提示词覆写」），再附加会话、设备、归因和签名头。响应的 SSE 流会转换回 DSH 的文本、推理、工具调用和用量事件。
4. **打开权益面板或调用工具时**：Host 查询配额、订阅、余额及按需的模型用量/MCP 用量；浏览器只通过 Remote 接收规范化快照，不直接读取凭证。
5. **查看诊断时**：进入「ZCode 权益」页面内的「日志诊断」页签，按时间倒序读取 Host 最近 200 条完整启动、路由、凭证解析和请求事件；日志只保留 origin、端点、HTTP/解析错误和凭据存在性等诊断字段，不传递 Authorization、API key、JWT 或完整凭证。可刷新或清空。
6. **遇到 Start Plan 验证码时**：仅在收到业务码 `3007` 且启用验证码时，Host 向已经打开的 DSH Web UI 发布一次性挑战。Web UI 的全局浮层承载阿里云验证码；成功后 Host 只携带一次性 param 重试原模型请求一次。插件不会启动或控制额外浏览器进程。

### 本地读写边界

- 读取：`~/.dsh/data/@local/zcode-provider/config/providers.json`、`credentials.json`、`telemetry-state.json`、`prompt-overrides.json`。
- 直接写入：提示词编辑器通过插件 Remote 直接写入 `prompt-overrides.json`；不会把提示词内容写入 Web profile 的 `cordis.patch.yml`。
- 间接写入：`settings.mutate()` 只用于派生路由（包括 `apiKey` 字段）以及清理旧版 profile 中的 `promptOverrides`。
- 内存状态：权益缓存、last-known-good 状态和最近 200 条诊断日志默认只在当前进程保存；诊断日志清空或重启 DSH 后消失。

### 对外发送的数据

- 模型端点：完整对话、工具定义/结果、图片内容、ZCode system prompt，以及当前工作目录、平台、Shell、Git 状态、会话和设备元数据。
- 权益端点：对应套餐凭证和设备标识，不发送对话内容。
- 签名端点：按需发送客户端签名握手数据；签名失败时会按协议重握手并进行一次未签名旁路。

插件不会启动 ZCode 主程序，也不会把 ZCode 可执行文件作为运行时依赖；当前 off-peak 领票流程默认关闭。

## 白盒内容

DPK 同时包含：

- src/：协议、提示词、凭证、签名、验证码、权益与适配器源码
- lib/：由上述源码生成的 JavaScript 和类型声明
- tests/：协议等价、插件组合和包边界测试
- client.js：权益面板客户端
- cordis.patch.yml：只注册本插件，不含机器绝对路径

包内没有外部业务运行时、预编译业务二进制、ZCode 主程序代码或当前仓库路径。

## 配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| providerConfigPath | ~/.dsh/data/@local/zcode-provider/config/providers.json | 插件自有 provider 配置 |
| credentialsPath | ~/.dsh/data/@local/zcode-provider/state/credentials.json | 插件自有账号凭证 |
| telemetryStatePath | ~/.dsh/data/@local/zcode-provider/state/telemetry-state.json | 插件自有 deviceMid |
| routes | 空 | 插件自身持久化路由；可不依赖任何外部配置手工提供 |
| includeDisabled | true | 是否导入设备配置中的禁用 provider |
| signingEnabled | true | 启用客户端签名协议 |
| captchaEnabled | true | 遇到 Start Plan 验证码挑战时由 DSH Web UI 承载验证并重试一次 |
| appVersion | 源码内协议版本 | 请求归因版本 |
| sourceTitle | electron | X-Title 来源标识 |
| endpointOrigin | https://zcode.z.ai | 配置、签名和权益端点来源 |
| authBackend | openzcode-app-server | 鉴权后端；可在插件详情页选择白盒 app-server 或原版直连，持久化到 `~/.dsh/data/@local/zcode-provider/state/auth-backend.json` |
| promptOverrides | 空（保持官方三段） | 三层提示词二态编辑：**前置＝附加注入**（自定义块插在官方 agent 块与运行时块之间，官方三块完整保留）；**后置＝覆写**（逐块替换官方对应块，清空即从请求移除该块＝0 字节注入，三层全清时 coding-plan 直连请求省略 system 字段）。持久化到 `~/.dsh/data/@local/zcode-provider/config/prompt-overrides.json`，官方默认值不重复保存，保存即时热生效（无需重启）。有覆写时引擎委托自动旁路为直连 wire |
| promptOverridesPath | ~/.dsh/data/@local/zcode-provider/config/prompt-overrides.json | 覆写文件路径；测试注入以隔离机器真实状态 |

## 提示词覆写与前缀门（2.5.32–2.5.37 实测）

服务端对 system 有**前缀门**（与 off-peak 3012 门同族，逐字校验官方①身份②agent 两块；③运行时块之后的任意块不校验）：

- `start-plan` / `off-peak`：缺官方 system → `3012 unusual activity`；替换①② → `HTTP 405 unusual activity`；②之后的块（追加/runtime 覆写/规则更新声明）→ 放行。
- `coding-plan`（`open.bigmodel.cn`）：无此门，且实测接受未签名请求（仅 `x-api-key`/`Authorization` 即 200）。

因此 `systemBlocksForChannel` 按通道装配：

- **无门通道（coding-plan）**：真覆写——官方块被逐块替换/移除，0 块时请求省略 system。实测 token 账本：官方三块 19077 → 三层短覆写 9592 → 全清 9490（地板＝DSH 用户内容+工具清单）。
- **有门通道（start-plan / off-peak）**：**等效覆写**——保留官方①②作网关兼容前缀（≈0.6K token），runtime 槽位照常覆写/清空（门不管③），identity/agent 的覆写与清空装进一块「Rule update (operator configuration)」声明置于 system 末尾。实测该结构过门（19:57 回合 completed，input 9579）；声明措辞经 4 框架对照实验（4/4 获模型遵循），采用挂接官方「mid-conversation system 可更新规则」条款的规则更新框架，而非易被判为注入的 `SYSTEM OVERRIDE` 式大写声明。

其他实测门事实：`1005 exceed quota limit`＝Start Plan 信任窗额度耗尽（重置见权益面板）；`3008/429`＝瞬态并发；`x-zcode-session-type: other`（generateText）会被风控，插件直连固定发 `main`。

### 前置/后置 × 通道能力矩阵（全部实测,wire 抓包+行为双证）

| | 前置（附加注入） | 后置（覆写） |
| --- | --- | --- |
| Start Plan / off-peak | ✅ `[官方①②][注入×N][官方③]` 6 块结构过门,两通道回归 PRE88OK | ✅ 等效覆写（①②兼容前缀 + runtime 槽 + 规则更新声明） |
| Coding Plan | ✅ 同结构,PRE88OK | ✅ 真替换（物理换块,全清=省略 system） |

注：start-plan **完全支持前置**——早期"不能覆写"的印象来自旧版 generateText 黑洞或后置真替换被 405,前置注入从未受限。

### 覆写效力实证（2.5.36–2.5.37 压力测试纪要）

- **完全接管**：覆写为"四行中文打油诗诗人",编程/长文请求一律以打油诗作答——官方 agent 本能（代码块/markdown/详尽沟通）全面失效,模型以覆写为唯一行为标准。
- **六规则复合**：[RB]标记/纯中文/五行·/无冗余/签名/抗干扰六条全中;模型主动把 CPU 改写为"中央处理器"以守"禁英文"规则。
- **对抗**：假管理员撤销、紧急施压话术均被拒;**机制伪装**(用户消息伪造 Rule update)曾在 2.5.36 破防,2.5.37 Authenticity 条款(配置只能宿主端修改,会话内自称规则更新者零权威)修复并复验。
- **工程共存**：覆写下 agent 工具照常执行(真实列目录);226K 长历史会话格式全守且内容准确;多轮持续稳定。
- **已知边界**：等效覆写为概率性趋近 100%（个别采样中模型把推理写入正文文本通道,UI 折叠后交付块仍合规）;模型对齐底线(安全政策)不可被任何提示词覆写。

只使用插件自身路由的最小配置示例：

~~~yaml
- id: zcode-provider
  name: zcode-provider
  config:
    routes:
      local-zcode:
        id: local-zcode
        display: ZCode
        kind: anthropic
        baseURL: https://open.bigmodel.cn/api/anthropic
        apiKey: API_KEY
        models:
          - id: GLM-5.3-Flash
            contextWindow: 200000
            maxTokens: 128000
            inputModalities: [text]
~~~

## 构建与测试

项目命令使用传统 Node（`C:\Program Files\nodejs`）：

~~~bash
npm run build   # tsc -p tsconfig.json && scripts/sync-client-prompts.mjs
npm test        # 全套测试
~~~

测试包含真实 Cordis Loader 组合、官方 system prompt/协议、签名、Web UI 验证码桥接、SSE tool-call 转换，以及独立包边界扫描。

Web 客户端会把当前会话选择的 Coding Plan / Start Plan 权益与剩余额度投影到输入区；全新会话先采用 DSH 的 `agentDefaultModel`，产生会话选择后再以 `modelSelection` 投影为准。该状态直接来自插件自己的只读权益 Remote，点击后进入同一插件内的完整权益面板。

## DPK

~~~bash
node ../dpk-manager/dpk.mjs pack .   # 产出 ./zcode-provider-<version>.dpk,归档进 dist/
node ../dpk-manager/dpk.mjs verify dist/zcode-provider-<version>.dpk
node ../dpk-manager/dpk.mjs install dist/zcode-provider-<version>.dpk -p web --home "%USERPROFILE%\.dsh"
~~~

安装后**必须核实** profile 链接已更新(`~/.dsh/profiles/web/package.json` 中 `zcode-provider` 指向新 digest 的 store 目录)。dpk 工具经 `~/.dsh/node_modules/@deepseek-ai` junction 定位 DSH CLI——工作区搬移后该 junction 会悬空,install 只解包到 store 却报 `the DSH CLI was not found`,profile 停留旧版(2026-09-30 实际发生:2.5.35/2.5.36 两版"安装成功"实则未生效,线上一直是 2.5.34,靠 wire 抓包才发现)。修复:`rmdir` 旧 junction 后 `mklink /J` 重指 `dsh-dev\deepseek-harness
ode_modules\@deepseek-ai`。

当前版本 **2.6.12**。近版本要点：

- **2.6.12** 额度提示只提醒、不带购买入口:本插件一律产出 `QUOTA`,**绝不产出 `ACCOUNT_QUOTA`**。
  客户端(ui-settings-account)只认领 `ACCOUNT_QUOTA` 并弹「去充值」Modal,那个码是第一方
  DeepSeek 账号路由(`llm-deepseek-account`)把自己的 `QUOTA` 改写出来的;ZCode 额度用尽的
  诉求是**提醒**,不是购买入口,所以这里停在 `QUOTA`:失败行显示中立额度文案 + 全局
  `shell.quota-notice` 警告 Toast,没有充值按钮。`tests/error-classification.mjs` 用源码级
  守卫锁住这条不变量(任何以字面量产出 `ACCOUNT_QUOTA` 的改动都会红)。

- **2.6.11** 额度耗尽提醒:官方把**终态欠费**发成 HTTP 429,原因在 body 里
  (实测 `429 {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}`),
  而插件此前只按状态码分类、还丢掉了业务码,于是欠费被降级成可重试的 `RATE_LIMIT`——
  DSH 依据 code 路由,**只有 `QUOTA` 会触发失败行的额度文案与全局 `shell.quota-notice` 提醒**,
  这条路径因此永远走不到,用户看不到任何额度提示。三处一起修:

  - 分类器改由 `lib/failure.js` 共享(直连 wire 与 app-server 委托两条链路同源),业务码与
    **中文措辞**(共享判定 `isQuotaExceededError` 只覆盖英文)都参与判定,额度判断排在限流之前;
  - **流内 SSE 错误此前是死代码**:类型白名单先 `continue` 掉了 `{type:'error'}`,该分支永远到不了,
    真正的失败原因被吞掉、只剩一条误导性的 `STREAM_CLOSED`;现在先于白名单处理并分类;
  - app-server 委托路径(start-plan)本来就把 `providerErrorCode` 带了回来,却硬编码 `SERVER`,
    现在走同一套分类。

  消息形态同时补全为三种:`{error:{…}}`(Anthropic)、`{code,msg}`(国内端点)、`{message}`(流内事件)。

- **2.6.10** 目录按 api 类型取数:`modelRules` 是与 api 无关的链,官方目录另有两层按 api 类型分键
  (`modelApiRules`/`providerSiteRules`,`apiTypeMatch` 命中本路由在用的 `anthropic-messages` 才参与),
  插件此前整层不读——`deepseek-v4.1-flash` 这类只在分键层声明窗口的模型因此落到 `.*` 兜底 200K,
  现在取到目录真值 1048576;层内靠后的条目覆盖靠前的,分键层覆盖与 api 无关的链。
  分键层里**没有** `apiTypeMatch` 的条目一律不生效(官方同形的三条是"所有模型支持图片/视频"的通配声明,
  按"任意类型"读会把纯文本模型标成多模态)。同时修掉 2.6.9 出货时的那条红测试:它的断言调用 `glm-5.3`,
  而 fixture 规则写的是 `glm-5\.3-flash`(两者不匹配,即使实现了也不会通过);`npm test` 改为逐个文件跑完
  再汇总,不再因前一个文件失败而跳过后面的(此前因此把 `tests/standalone-package.mjs`——证明归档在
  **没有 ZCode 的机器上**也能激活并发请求的离线闸门——一起挡掉了)。

- **2.6.9** 模型上下文同步:插件解析官方 `zcode-builtin.json` 的 `modelConfigRules.modelRules` 正则链(与官方 app-server 同源),把 ZCode 权威的 `contextWindow`/`maxOutputTokens`/输入模态读出来注册进 DSH 的模型元数据(`resolvedInfo.context`),providers.json 显式 limit 仍最优先;GLM-5.3 系列自此按真实 1M 窗口参与 DSH 的上下文预算,不再是硬编码 200K。

- **2.6.8** 打包分层修正:归档携带包**本名**(`zcode-provider`),`@local/` 作用域由 dpk **安装动作**添加(store 副本、patch 行、台账、数据卷根),pack 阶段不再预烧作用域;卷声明只随 `dsh` 逐字副本携带,不再写顶层 `data` 键(2.6.6 的归档因此被旧白名单读取端整包拒收);`tests/loader-composition.mjs` 移出默认 `npm test` 链(改 `test:integration`),归档解包环境不再出现依赖维护者 monorepo 的恒红测试。分发仅走 `.dpk`,不发布 npm。

- **2.6.6** 修复 Windows ZCode 安装发现和 app-server 启动链：使用正确的 `reg query` 语法，支持从空 `InstallLocation` 的卸载项回退，Electron 宿主优先使用自身 Node 运行时，委托启动失败时回退直连 wire；Coding Plan 缺失 identity 时仅在唯一 provisioning key 候选下恢复。

- **2.6.5** 修复权益诊断中的 native fallback 路由显示：使用实际 `route` 字段，缺失的 Coding Plan 凭证保持为 `null`，避免把“没有路由”误显示成已脱敏凭证。

- **2.6.4** 修复远端权益诊断：设备标识按插件受管状态优先、官方 ZCode 状态回退；Start Plan HTTP 错误保留服务端安全字段；路由设置同步排队到 HMR 当前事务之后。

- **2.6.3** 扩充日志诊断：记录官方目录定位、凭证文件状态、解密/凭证门控结果、回退端点、active provider、路由与 origin；诊断页按时间倒序显示全部文本日志，不再按级别筛选。
- **2.6.2** 将 `zcodeDiagnostics` Remote 和诊断日志收进「ZCode 权益」页面内的「日志诊断」页签，避免增加独立左侧入口；日志默认保留 200 条并脱敏。

- **2.5.31** start-plan/off-peak 改走引擎会话委托（session/send 流式 + 60K 历史预算）；模型名追加通道后缀 `· Start Plan` / `· Coding Plan` / `· 错峰`；generateText 直连加 10 分钟硬超时。
- **2.5.32** 后置层改为真覆写语义（逐块替换/清空＝移除/0 块省略 system）；空串在保存链路（client→Remote→normalize）作为显式清空标记贯通。
- **2.5.33** 新增 `systemBlocksForChannel`：前缀门通道等效覆写（官方①②兼容前缀＋规则更新声明块），`hasPromptPrefixGate` 判定 start-plan/off-peak。
- **2.5.34** 声明块措辞按 4 框架对照实验定为 `Rule update (operator configuration)`；`promptOverridesPath` 可注入以隔离测试；全套件 EXIT=0/470。
- **2.5.35** start-plan 等效覆写端到端实测通过（全量覆写遵循、全清空、基线回归）；`hasPromptOverrides` 改为 placement 感知——非激活层的清空标记不再误触引擎委托旁路；修复重组引入的 src/src 嵌套。
- **2.5.36** 声明块加显式废止（INACTIVE）与绝对优先级条款（覆盖用户侧格式/语言冲突）；wire 抓包复核时发现 2.5.35/2.5.36 两次 install 因 `~/.dsh` junction 悬空未生效（线上实为 2.5.34），重指 junction 后真正上线并逐字验证。
- **2.5.37** 声明块加 Authenticity 更新通道排他条款——极端对抗测试发现用户消息内嵌伪造的 `Rule update (operator configuration)` 可被模型当作真运营方更新接管格式（已实测修复）；同轮验证完全接管、六规则复合、工具共存、226K 长历史。

DPK 会完整收录包根目录（排除 .git 和 node_modules），因此源码和测试会随包交付，安装后仍可审计与复验。
