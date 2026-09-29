# zcode-dev 工作区分析报告

> **⚠️ 状态更新(2026-09-29 晚)**:本报告为当日早间快照,此后主要变化——
> ① MSYS2 已整体删除,全部 Node/npm/pnpm 迁至传统 Node(`C:\Program Files\nodejs`);
> ② 新增 `re-app-server/`(官方 app-server 白盒逆向工作区,README 含宿主剧本/事实链/前缀门 §0.7);
> ③ 主线插件已演进到 `zcode-provider@2.5.34`(引擎会话委托、通道标签、提示词前置注入/后置覆写、
> 前缀门等效覆写;详见 `dpk/zcode-provider/README.md`);④ `launcher/dsh.cmd` 已固定传统 Node。
> 以下原文作为历史盘点保留。

> 只读盘点，生成于本次会话。工作区根目录无 Git 仓库（只有一份为“未来工作区仓库”准备的 `.gitignore`），
> 内部是一组**互相嵌套的独立仓库 + 逆向产物 + 自研实现**。
> 报告不含任何凭据值，只标注凭据所在位置。

---

## 0. 一句话结论

这是一个**以“在 DeepSeek Harness(DSH) 里白盒复刻 ZCode 客户端协议、从而使用本账号 BigModel Coding Plan / Start Plan 权益”为主线**的研究型工作区。
它同时容纳了四代自研接入实现、一整套对官方 ZCode 桌面版/CLI 的逆向证据链、一个纯 Rust 复刻引擎与 TUI，以及对 DSH 本身的 Windows/MSYS2 兼容性补丁。

工作区总计约 **7.5 GB**，其中约 **6.0 GB** 是官方二进制/解包产物与 `node_modules`、`target/`；第一方“源码/脚本/证据”约 **400 MB**。

---

## 1. 顶层地图（16 个目录）

| 目录 | 性质 | 规模(含全部内容) | 作用 | 状态 |
|---|---|---|---|---|
| `deepseek-harness/` | 上游 Git 仓库 | 4.71 GB | DeepSeek Harness 本体（宿主）。`master`，HEAD=`00102833df`，tag `dsh-v0.1.7-alpha.2`，与 origin 齐平，**8 个文件未提交** | **活跃**（有本地改动） |
| `dpk/zcode-provider/` | 自研源码 | 55 MB（多为 node_modules） | 主线交付物：白盒 ZCode-compatible DSH 插件 `zcode-provider@2.5.26` | **活跃主线** |
| `zcode-cli-rs/` | 自研源码（Rust） | 411 MB（多为 `target/`） | Rust 复刻：ConPTY 驱动 → 原生 agent → 纯 Rust 引擎+TUI | **活跃**（未提交） |
| `tui-build/` | 自研/抽取源码 | 131 MB | ZCode CLI/TUI 前端的独立 TypeScript 可构建副本（`@zcode/{tui,shared,contracts,i18n,model-option-map}`） | **活跃** |
| `dpk/zcode-provider/dist/` | 构建产物 | 11 MB | 40 个插件发布包 `2.0.0`→`2.5.34`（2026-09-29 起统一收纳于 `dist/`） | **活跃** |
| `launcher/` | 脚本 | 0.1 MB | Windows 单入口 `dsh.cmd`（提权 + 固定 51080 + MSYS2 native 修复） | **活跃** |
| `.zcode-analysis/` | 逆向证据 | 19.8 MB / 430 文件 | 主分析报告（1316 行）+ 2 篇深挖 + 复核脚本 + 原始抓包/提取件 | **活跃** |
| `.debug/` | 实验/草稿 | 249 MB / 1716 文件 | 抓包 Hook、探针、代码生成补丁脚本、46 个 `tui-probe-*` 抓帧、构建日志 | **实验**（内含 3 个可复用件） |
| `zcode-cli/` | 抽取产物 | 250 MB | 从官方安装包提取的独立 CLI 运行时（`glm/zcode.cjs` 14.8 MB + 15 插件 + rg/ugrep/cua） | 半归档（被 zcode-unpacked 取代） |
| `ZCode-open/` | 上游 Git 仓库 | 393 MB | 官方开源的 ZCode 源码（`zai-org/ZCode`，Apache-2.0，v3.14.0，仅 2 个提交） | 参考（clean） |
| `opencode/` | 上游 Git 仓库 | 654 MB | 第三方开源 agent（`anomalyco/opencode` v1.18.32，branch `dev`） | 参考（clean） |
| `asar-extracted/` | 归档 | 311 MB | 官方桌面 3.14.1 的 asar 解包（main/host/preload/renderer/scheduler） | 归档 |
| `zcode-unpacked/` | 归档 | 731 MB | 官方桌面 Electron 安装目录（`ZCode.exe` 213 MB、app.asar 328 MB） | 归档 |
| `.artifacts/official/` | 归档 | 170 MB | 官方安装包原件 `ZCode-3.14.1-win-x64.exe` | 归档 |
| `dsh-zcode-bridge/` | 早期实现 | ~4 KB | 第一代 DSH 桥接插件（90 行），未接入 profile | **已废** |
| `src/`（`src/agent`、`src/tools`） | 空目录 | 0 | 无内容残留 | 死目录 |

另有 `PROJECT-ANALYSIS.md`（本报告）。

---

## 2. 结构关系：四层

```
[第四层 参考源码]   ZCode-open(官方开源) 、opencode(第三方) 、tui-build(前端副本)
                       │ 用来对照协议、字段、TUI 规格
                       ▼
[第三层 逆向资产]   .artifacts(安装包) → zcode-unpacked(解包) → asar-extracted(asar 解出)
                    zcode-cli(提取的独立 CLI)  .zcode-analysis(证据/报告)  .debug(探针)
                       │ 提取线格式：头、签名、票据、验证码、权益端点
                       ▼
[第二层 自研接入]   zcode-provider 插件(主线) ← 演进自 → zcode-rs(Rust 引擎+TUI)
                    zcode-cli(打补丁的官方 bundle) 、zcode-cli-rs(v0.1/0.2) 、zcode-bridge(最早期)
                       │ DPK 打包 + profile 安装
                       ▼
[第一层 宿主]       DeepSeek Harness(deepseek-harness) + launcher/dsh.cmd + ~/.dsh profile
                    本会话的 Web GUI 就跑在这一层（127.0.0.1:51080，PID 9088）
```

关键事实：**这条链路是“活的”**——本会话可用工具里就有插件注册的 `zcode_usage`，且 `~/.dsh/profiles/web/package.json` 的 bundles 含 `zcode-provider`。

---

## 3. 主线交付物：`dpk/zcode-provider`（v2.5.26）

**定位**：一个可独立打包成 DPK 的 DSH 插件，在包内以可读 TS/JS **完整实现** ZCode 兼容的模型协议与账号权益接入；**运行时不启动也不依赖 ZCode 主程序**。

**架构边界**
```
DSH UI / history / tools / agent loop
  → zcode-provider（白盒适配层）
  → Anthropic-compatible HTTP + ZCode 头/签名/验证码
  → BigModel(open.bigmodel.cn) / Z.ai(zcode.z.ai)
```

**源码模块**（`src/`，约 33 万字符，全部带中文/英文契约注释）

| 文件 | 体量 | 职责 |
|---|---|---|
| `index.ts` | 75 KB | 插件主体：配置 schema、路由派生、DSH→Anthropic 请求转换、SSE→DSH 流转换、`zcode_usage` 工具注册、`apply()` |
| `usage.ts` / `usage-remote.ts` | 37 KB + 4.6 KB | 配额/用量/余额查询与 Remote 投影 |
| `openzcode-app-server.ts` | 30 KB | 对照传输：拉起 `node zcode.cjs` app-server 子进程（可选，默认关闭） |
| `offpeak.ts` | 29 KB | 错峰/空闲额度**票据协议**（availability→ticket→status→settle 状态机），默认关闭 |
| `entitlements.ts` | 24 KB | 账号权益域模型（start-plan / individual|team coding-plan / off-peak、last-known-good 状态机） |
| `official-wire.ts` | 19 KB | 出站线格式：归因头、请求身份头、客户端签名（HKDF+HMAC+Ed25519+PoW） |
| `captcha.ts` / `captcha-remote.ts` | 15 + 18 KB | 业务码 `3007` 的阿里云验证码挑战，交给已打开的 DSH Web UI 承载，成功携一次性 param 重试一次 |
| `official-prompt.ts` | 12 KB | 官方三段 system prompt 逐字投影 |
| `credentials.ts` / `auth-backend.ts` / `storage.ts` / `prompt-*.ts` | 小 | 凭证解密、鉴权后端选择、插件私有存储 |

**测试**：`tests/` 20 个 `.mjs`，含真实 Cordis Loader 组合、协议等价、签名、验证码桥接、SSE tool-call、独立包边界扫描；报告记录全套件用例数（equivalence / cred 13 / route 19 / usage 79 / offpeak 110 / prompt 30 / captcha 68 / wire 62 / loader 23）。

**发布形态**：`dpk/zcode-provider/dist/zcode-provider-2.5.26.dpk` → 用 `.debug/dsh-package-manager-1.1.1/dpk.mjs pack|verify|install --profile web` 安装到 `~/.dsh/profiles/web`；安装记录在 `~/.dsh/dpk/index.json`（含 1.4.0→2.5.26 共 40+ 次安装的完整历史）。

**当前运行期接线**（`~/.dsh/profiles/web/cordis.patch.yml`）
- 路由：`builtin:bigmodel-coding-plan`（`open.bigmodel.cn/api/anthropic`，GLM-5.3/5.3-Flash/5.2）、`builtin:bigmodel-start-plan`（`zcode.z.ai/api/v1/zcode-plan/anthropic`）、以及两条第三方路由（deepseek、agnes）。
- `appServer`：node=`msys64/clang64/bin/node.exe`，cliPath=`zcode-unpacked/resources/glm/zcode.cjs`，storageDir=`~/.zcode/v2`。
- ⚠️ 该文件以**明文**保存了解密后的 `apiKey`（Coding Plan key、Start Plan JWT、DeepSeek/Agnes key）。插件 README 明确说“凭证不写入 DPK”，但 profile patch 里确实存在明文——两者是不同层面，但值得注意。

---

## 4. 自研实现的演进谱系（同一目标的四代）

| 代 | 位置 | 形态 | 现状 |
|---|---|---|---|
| ① 桥接 | `dsh-zcode-bridge/index.ts`（90 行） | DSH Cordis 插件，直接读 `~/.zcode/v2/config.json`，复用 `DeepSeekAdapter` 注册路由 | 未接入任何 profile，被②取代 |
| ② 补丁 | `zcode-cli/` | 从官方安装包提取 CLI 后打 2 处 patch + 注入 `ZCODE_APP_VERSION`，使**默认出站的归因头与官方桌面一致**（`cli`→`electron`） | 可用但依赖官方 bundle；已被 `zcode-unpacked` 版本覆盖 |
| ③ Rust | `zcode-cli-rs/` | v0.1 ConPTY 驱动抓帧/渲染；v0.2 原生 agent 核心（双协议 SSE、bash/read/write/edit/glob/grep、jsonl 会话、复用桌面凭证）；`src/bin/zcode-rs.rs`（**83 KB，未提交**）= 纯 Rust 引擎 + 全屏 TUI（无 Bun、无 `zcode.cjs`），实现 AES-256-GCM 凭证解密 → Provider 注册 → 双协议直调 → TUI（规格取自 `@zcode/tui`） | **活跃**，`target/release/zcode-rs.exe` 已构建 |
| ④ 插件 | `dpk/zcode-provider/` | 成熟、可发布、有测试与权益面板的 DSH 插件（本文 §3） | **主线** |

补充：`.debug/patch-*.py`（约 20 个）并非改 bundle，而是**代码生成器**，反复重写 `zcode-cli-rs/src/bin/zcode-rs.rs` 与 `dpk/zcode-provider/src/index.ts`（输入面板、MCP、delegate、effort 历史、diff 渲染、快捷键等），配 `.debug/agent-tools.rs`、`.debug/tui-section.rs` 作为片段来源。

---

## 5. 逆向证据资产

### `.zcode-analysis/`（完整：248 文件 + 3 子目录）
- **主报告 `权益差异分析报告.md`**：1316 行、§0–§20，**15 轮对齐记录**（v1.0.0→v1.13.0 命名，对应插件后来的 1.x/2.x）。
  - §0 结论：BigModel 通道**确实在用 Coding Plan 权益**（端点与凭证逐字节等价 E1、归因头对结果无影响 E2、额度计数随调用前进 E3）；「和官方不一样 ⇒ 用不到权益」不成立；真正丢权益的是 Start Plan/off-peak 通道（需阿里云验证码头）。
  - 差异清单 D1–D7：只有 D2（captcha/JWT 通道）当天真丢权益，D1（客户端签名）是将来风险，其余为行为/观感差异。
  - §20.4 终局：Coding Plan 权益在用（30 天窗口 104.23 亿 tokens / 27402 次调用），**唯一走不通的是错峰派发，已按用户要求禁用、协议留档**。
- **两篇深挖**：`sub-a/desktop-entitlement.md`（37 KB，桌面版权益判定/端点/签名/归因）、`sub-b/cli-wire.md`（55 KB，CLI 引擎真实在线格式：`createCodingPlanApiKeyResolver`、`ClientRequestSigningV4Manager`、强制头、Anthropic body、`/login` 流程），并附 ~180 个按符号命名的提取件与偏移索引。
- **可复核脚本**：~40 个 `verify-*.mjs`、~30 个 `probe-*.mjs`、MITM 代理（`mitm/`）、CDP 验证码驱动、凭证解密/重加密、`redact_secrets.mjs` 等。
- 10 个历史 DPK（`1.4.0`→`1.16.0`）也放在这里。

### `.debug/`（草稿区）
- 可复用：`dsh-package-manager-1.1.1/`（实为 **1.1.5**，DPK 打包/校验/安装工具，含 GUI 面板与 `SPEC.md`）、`dsh-runtime/`（第二套 DSH home）、`node22/`（便携 Node 22.19.0）。
- 关键证据件：`system-prompt.txt`（官方三段提示词）、`ticket-client.txt` / `offpeak-server.txt`（票据协议提取）、`zcode-capture.cjs`（14.8 MB bundle 副本）、`header-hook.js`（在 `convergence-backup-114516/_debug-scripts/`，`net.Socket.write` 挂钩抓明文头）。
- 46 个 `tui-probe-*` 目录 = TUI 逐帧抓取与回归对比（`step-NN.txt`）。
- 归档：`convergence-backup-114516/`（早期 CLI 收敛工作的完整快照）。
- ⚠️ 存在敏感文件：`credentials.json.bak-100920`、`dsh-api-key.txt`（本次未读取）。

### 官方产物三层
`.artifacts/official/ZCode-3.14.1-win-x64.exe`（原件）→ `zcode-unpacked/`（安装目录，含 `resources/app.asar` 328 MB、`resources/glm/zcode.cjs` 14.79 MB、`config/provider/zcode-builtin.json` 188 KB）→ `asar-extracted/`（`out/{main,host,preload,renderer,scheduler}` + `metadata/build-meta.json`：`appVersion 3.14.1`，`buildCommitId cead36fd`，`buildTime 2026-09-20T07:37:29Z`）。

---

## 6. 参考源码仓库

- **ZCode-open**（`zai-org/ZCode`，Apache-2.0，v3.14.0）：三个表面（Electron 桌面 / Web / 终端 CLI+TUI）共用一套 agent core；pnpm monorepo，`packages/` 14 个包 + `apps/zcode-cli` 内嵌 16 包工作区（turbo）。**注意**：无 `docs/` 目录但被多处配置引用；`@zcode/zcode-cua`（Computer Use）与 `swift-bridge` 是**明确的 fail-closed 占位包**；`packages/stream-animate` 只在 `.gitignore` 中出现；AGENTS.md 明文要求“不自行恢复已移除的模块或内部依赖”；历史被压成 2 个提交（`Initial commit` + `feat: open source`，作者 wuweiqi，2026-09-21）；**仓库内没有统一测试运行器**，只有 4 个测试文件。
- **opencode**（`anomalyco/opencode`，MIT，1.18.32，branch `dev`，Bun+Effect）：CLI/TUI + desktop + web + console + SDK，33 个 `packages/*`。与 ZCode 双向**无代码引用**，属“同赛道参考实现”。
- **tui-build**：把 ZCode 前端包抽成 npm workspaces（`shared`/`contracts`/`i18n`/`tui`/`model-option-map`）后可独立 `tsc` 构建；`tui/` 内有 ~85 个 `app-*.ts(x)` 与 `SUBAGENTS.md`（TUI 中观察 subagent 的行为契约）。用途推断为：脱离官方 bundle 研究/改造 TUI。

---

## 7. DSH 本地改动（8 文件，+88/−29，全部未提交）

主题：**让 DSH 能在本机 Windows 的 `--expose-internals` 源码启动、以及 MSYS2 风格 Node（`node.exe` + `libnode.dll`）下正常工作**。

| 文件 | 改动 | 性质 |
|---|---|---|
| `.gitignore` | 增加 `/.dsh/`、`*.dpk` | 忽略本机 DSH home 与 DPK 产物 |
| `apps/cli/src/profile-boot.ts` | 值导入 `FiberState` 改为类型导入 + `const FIBER_ACTIVE = 2 as FiberState.ACTIVE` | **运行时致命修复**：Cordis 的 `FiberState` 是 const enum，构建产物不导出，原值导入在运行期无法加载 |
| `packages/boot/app-boot/src/profile-resolution/resolver.ts` | 新增 `requireInternal()`：先普通 `require('internal/...')`（`--expose-internals` 下可用），`MODULE_NOT_FOUND`/`ERR_UNKNOWN_BUILTIN_MODULE` 时懒加载 `node-addon-require-builtin` 兜底 | 去掉本地源码启动对 native addon 的硬依赖 |
| `packages/boot/app-boot/src/profile.ts` | `removeLinkProjections()` 在 `rmSync` 前先断开 `owned` 目录下所有 symlink | **防数据丢失**：避免递归删除跟随 Windows junction 删到真实目录 |
| `packages/subprocess/win32-process/src/ffi.ts` | 新增 `uvGetOsfhandleBinding()`：先 `koffi.load(null)`，失败且 win32 时回退 `koffi.load('libnode.dll')` | MSYS2 把 Node 拆成 exe+dll，该导出在 dll 上；否则 Job 进程 spawn 在绑定阶段即失败 |
| 3 个测试文件 | 同步上述改动（新增 `requireBuiltin()` helper、libnode 分支断言） | 测试对齐 |

**同类的潜在未修问题**（本次盘点发现，未改动）：`packages/boot/config-editor/src/index.ts:5` 仍以值方式导入 `FiberState` 并在第 90 行读取 `FiberState.ACTIVE`。另：仓库内 `rg 51080` 为 0 命中，51080 来自 `launcher/dsh.cmd` 的显式 `--port`（上游默认是 3080）。

---

## 8. 启动链（当前实际运行形态）

`launcher/dsh.cmd`：校验管理员+High 完整性（必要时 `RunAs` 自提权）→ 固定传统 Node `C:\Program Files\nodejs\node.exe` → `DSH_HOME=%USERPROFILE%\.dsh` → 从 `.debug\dsh-api-key.txt` 取 `DEEPSEEK_API_KEY`（若环境未设）→ `cd` 到工作区根（会话历史按 cwd 分组）→ 停 3080/51080 上的旧实例（只杀命令行含本 checkout `apps\cli\src\bin.ts` 的监听者）→

```
node --expose-internals --import <dsh>/node_modules/tsx/dist/esm/index.mjs ^
     <dsh>/apps/cli/src/bin.ts web --port 51080
```

已在运行中验证：`127.0.0.1:51080` ← PID 9088，正是该命令行；插件注册的 `zcode_usage` 工具在本会话可用。配套 `prepare-msys2-native.ps1` 会在需要时用 MSYS2 CLANG64 重新编译 koffi（官方预编译 MSVC 版会在 MSYS2 Node 下 dlopen 崩溃并使进程直接终止，JS 层 try/catch 无法拦截）。

---

## 9. 项目已经确立的结论（来自其自身证据）

1. **Coding Plan 权益确实在用**：与官方同端点、同凭证（AES-256-GCM 本地密钥解密后逐字段相等）、同账号；额度计数器随调用推进（86268→86269），而普通 API 路径返回 `429 code 1113 余额不足`。
2. **归因头（`X-Title` 等）不构成权益门禁**：官方自身在签名为不可用时 fail-open 发未签名请求；A/B/C 三种头组合响应逐字段相同。
3. **Start Plan / off-peak 是票据+验证码通道**：直连会得到 `400 code 3007 captcha verify failed` 或 `400 code 3001`；`3001` 的真身是**设备身份 `x-device-mid` 缺失**，`3012` 的真身是**缺官方 agent 系统提示词**——两者都已定位。
4. 官方 `coding-plan-cache.json` 的过期结论（`updatedAt` 早于套餐生效日）不可作为“无权益”的依据。
5. **错峰派发**（第十轮曾跑通）被服务端风控拦住，用户已决定禁用，协议全部留档（§19–§20）。

---

## 10. 风险与观察点

**安全/合规**
- `~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/zcode-provider/*`、`.debug/credentials.json.bak-100920`、`.debug/dsh-api-key.txt` 中存放**明文/可解密凭证**；工作区 `.gitignore` 只覆盖 `*.env`、部分 `credentials*.json`，未覆盖 DPK 内的 profile patch 副本。
- `zcode-cli/README.md` 明说做过**归因伪装**（把独立 CLI 伪装成官方桌面 `Z Code@electron`）。这是绕过服务端客户端识别的一层，属灰色地带；`zcode-provider` 的 `official-wire.ts` 延续了同一做法（并已把版本对齐到官方常量）。
- 工作区内含官方二进制的解包/提取副本（`zcode-unpacked`、`asar-extracted`、`zcode-cli/glm/zcode.cjs`、`.debug/zcode-capture.cjs`）。这些受 ZCode 自身许可与 `NOTICE.md` 约束，不应再分发。

**工程卫生**
- 版本口径不统一：产物是 **3.14.1**（build `cead36fd`，2026-09-20），而 `official-wire.ts` 自报 **3.14.3**（build `ab4d5e6b`，2026-09-22），本机未找到 3.14.3 安装；`zcode-cli/README.md` 又写 3.14.1；`ZCode-open` 源码是 3.14.0。
- 重复与残留：`zcode-cli/`（250 MB）已被 `zcode-unpacked/` 取代；`dsh-zcode-bridge/` 已废；`src/agent`、`src/tools` 为空；`tui-probe-*` 46 个目录、`.zcode-analysis` 里混放 DPK 与源码包边界样例；两套 DSH home（`~/.dsh` 与 `.debug/dsh-runtime`）。
- 3 个 Rust 二进制（`zcode-cli-rs.exe`、`zcode-rs.exe`、`zcode-cli.exe`、`pty-run.exe`）与 83 KB 单文件 `zcode-rs.rs` 均未提交、无 README 覆盖 `zcode-rs.rs`（README 只写到 v0.2）。
- `tui-build` 无 README、无 Git 元数据，来源（手写还是从 bundle/asar 重建）无法从仓库内确定。

**整理建议（按性价比）**
1. 把 `~/.dsh/profiles/web/cordis.patch.yml` 的明文 key 改成引用插件凭证存储，或把它纳入更严的忽略/加密策略。
2. 统一版本口径：确定“当前对标的官方桌面版本”，并让 `ZCODE_CLIENT_VERSION`、产物目录名、README 一致。
3. 给每个 `dpk`/`.debug/dsh-runtime`/`zcode-cli` 明确“归档/可删”标记，把 `zcode-cli/`、`dsh-zcode-bridge/`、空 `src/` 归档或删除。
4. 补 `zcode-cli-rs` 的 v0.3 文档（`zcode-rs.rs` 的架构、构建、与插件的分工），并提交或明确忽略。
5. 修掉 `packages/boot/config-editor/src/index.ts:5` 同类 const-enum 值导入（如上游未修）。

---

## 附：关键路径速查

| 需要什么 | 去哪里 |
|---|---|
| 主结论与 15 轮对齐史 | `.zcode-analysis/权益差异分析报告.md` |
| 桌面版权益判定细节 | `.zcode-analysis/sub-a/desktop-entitlement.md` |
| CLI 真实线格式细节 | `.zcode-analysis/sub-b/cli-wire.md` |
| 插件源码/测试 | `dpk/zcode-provider/src|tests` |
| 已安装插件与 profile | `~/.dsh/profiles/web/{package.json,cordis.patch.yml}`、`~/.dsh/dpk/index.json` |
| 纯 Rust 引擎/TUI | `zcode-cli-rs/src/bin/zcode-rs.rs` |
| TUI 前端源码副本 | `tui-build/{tui,shared,contracts,i18n,model-option-map}/src` |
| 官方源码对照 | `ZCode-open/{apps,packages}` |
| 官方二进制对照 | `zcode-unpacked/resources/{app.asar,glm/zcode.cjs}`、`asar-extracted/out` |
| DPK 工具 | `.debug/dsh-package-manager-1.1.1/dpk.mjs` |
| 启动/停止 | `launcher/dsh.cmd`、`launcher/stop-dsh.ps1` |
