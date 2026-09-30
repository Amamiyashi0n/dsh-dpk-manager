# DSH 安装包管理助手（dpk）

`dsh-dpk-manager` —— 把**一个标准 DSH 包目录**打包成单个 `.dpk` 文件（本质是 zip），
并在本地可靠地安装它。它是一个**标准 DSH bundle**（`dsh.bundle.patch` + 中文标题的插件卡片 +
图标），同时保留独立的 `dpk` 命令行：

| 形态 | 入口 | 用法 |
| --- | --- | --- |
| 会话内工具 | `index.js` → 注册 `dpk` 工具 | 装进 profile 后，agent 可直接 `dpk action=verify/install/…` |
| 命令行 | `dpk.mjs`（`bin: dpk`） | `node dpk.mjs pack/verify/install/…`，不需要 DSH 即可验真 |

```text
dpk pack <目录>            校验 DSH 合规 → 写出 .dpk（同输入逐字节可复现）
dpk verify <文件.dpk>      结构 + 完整性 + DSH 合规，全都不需要装 DSH
dpk install <文件.dpk>     验真 → 解到本地仓库 → 交给 DSH 自己的安装器
```

设计文档见 [SPEC.md](SPEC.md)（格式规范 v1，逐条可判定）；JSON Schema 见
[schemas/dpk-1.schema.json](schemas/dpk-1.schema.json)。

## 会话内工具 `dpk`

六个动作：`inspect`（只读清单）、`verify`（结构+完整性+DSH 合规）、`pack`（打进 `.dpk`）、
`install`（装进当前 profile）、`list`、`which`。

- 只有 `install` 会改 profile。它**先过沙箱提权判定**（`danger-full-access`，与官方
  `plugin_manager` 完全相同的请求与理由文本），再调用**同一个** `pluginManager` 服务；
  判定器或服务不可用时**一律拒绝安装**，并给出等价的
  `plugin_manager action=install_bundle target=<store 路径>` 调用。
- `dryRun: true` 只做验真与路径计算，报告确定性 store 路径与确切交接命令，**不写任何文件**。
- 本插件**不 import 任何 Harness 包**：`tools`、`sandboxPolicy`、`approval`、`pluginManager`
  全部经 `ctx` 服务拿；工具定义按 Harness 自己的参数 schema 形式手写，提权判定按
  `@deepseek-ai/dsh-sandbox#approveEscalation` 的规则与措辞镜像实现。这样一个 profile bundle
  在宿主自己的模块加载器下不会因为裸导入解析不到而失效，也让本包能作为 `.dpk` 自包含地分发。

安装这个助手本身（它用自己的格式装自己）：

```powershell
node dpk.mjs pack . -o ..\backup\local-dsh-package-manager-1.0.0.dpk
node dpk.mjs install ..\backup\local-dsh-package-manager-1.0.0.dpk --profile web
```

> **生效条件**：bundle 的 **config** 改动会热生效；但插件的 **JS 代码**改动不会——
> 宿主进程只会导入插件模块一次，之后一直用那一代（这与 DSH 自己的说明一致：
> 替换已安装的包需要重启才能加载新的 JS 代次）。所以首次安装或改了代码之后，
> 需要重启 Harness，会话内才会出现 `dpk` 工具。命令行始终可用，无需重启。

## 快速开始

```powershell
# 1) 打包（对任意标准 DSH 包目录）
node dpk.mjs pack .\plugins\dsh-reverse-skill -o dsh-reverse-skill-1.0.0.dpk

# 2) 校验（换台机器也能跑，纯 Node，无依赖）
node dpk.mjs verify dsh-reverse-skill-1.0.0.dpk

# 3) 本地安装（默认读 $DSH_PROFILE；--profile 可指定）
node dpk.mjs install dsh-reverse-skill-1.0.0.dpk --profile web
```

`install` 的输出会明确告诉你三件事：解到哪、用哪个 DSH 命令装的、账本记在哪：

```
package  @local/dpk-hello@1.0.0 (bundle)
store    C:\Users\…\.dsh\dpk\store\<digest>\package
profile  dpk-demo (installed by DSH)
```

**先试后装**：`--dry-run` 走完验真、算出确定性的 store 路径、打印将要执行的官方命令，但
**一个字节都不写**（不改 profile、不建 store、不记账）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pack <dir>` | 校验包目录并打 `.dpk`；`-o` 指定输出，`--created-at now` 记录真实构建时间，`--no-compress` 不压缩 |
| `verify <file>` | 完整校验：zip 结构/路径/限制、`dpk.json`、逐文件 sha256+size、整体摘要、并把 `package/` 解到临时目录重跑 DSH 合规 |
| `inspect <file>` | 只打印 `dpk.json`（不解包、不校验内容） |
| `install <file>` | 验真 → 解到 `store/<digest>/` → `dsh plugin --profile <p> install <abs path>`；`--dry-run` `--force` `--keep-archive` |
| `list` / `which <name[@ver]>` | 本地仓库账本与路径 |
| `uninstall <name>` | 交给 DSH 卸载并记账；`--prune` 连 store 一起删 |
| `version` | 工具与格式版本 |

`--json` 让所有命令输出机器可读结构。

## 为什么这样设计：它严格贴着 DSH 的标准

| DSH 的既有事实 | 出处 | DPK 的对应设计 |
| --- | --- | --- |
| 安装 spec 只认 `registry` / `path` / `git` / **`tarball`（仅 `.tgz`、`.tar.gz`）**；zip 会被判 `invalid-spec` | `packages/boot/plugin-manager/src/install-spec.ts:29,68-90` | `.dpk` 不冒充 spec：验真后**解包成目录**，再把**绝对路径**交给官方安装器（`kind: 'path'`） |
| 本地路径 spec 必须是绝对路径 | 同上 `:72-76` | store 用绝对路径寻址（`$DSH_HOME/dpk/store/<digest>/package`） |
| CLI 安装会跑 pnpm、写依赖，并在成功后把新 bundle 追加进 `dsh.profile.bundles` | `operations.ts:118,160`、`:78-96` | `dpk install` 只调用 `dsh plugin --profile <p> install <abs path>`，**不自己写 profile、不自己跑 pnpm** |
| bundle = `package.json` 里声明 `dsh.bundle.patch` | `packages/util/package-manifest/src/types.ts:69-72` | `pack` 校验补丁存在、在包内、是 `.yml/.yaml`，并把它复制进 `dpk.json` |
| 展示元数据读 `locale/<lang>.json` 的 `meta.title/description`；图标必须相对路径、允许的扩展名、realpath 在包内、≤256 KiB | `packages/boot/app-boot/src/package-meta.ts:10,15-19,24-39,101-122` | `pack`/`verify` 逐条镜像这些规则，不满足直接拒绝 |
| 包名文法与长度上限 | `install-spec.ts:31-32` | `dpk.json.name` 与 `package.json.name` 必须一致且通过同一文法 |
| DSH 读元数据时**不加载插件代码** | `package-meta.ts` 模块注释 | `verify`/`inspect` 同样不执行包内任何代码 |

一句话：**DPK 只负责运输与验真，DSH 仍是唯一事实源。**安装完成后 profile 里躺着的是一条普通的
`link:` 依赖，DSH 完全不知道 DPK 存在；升级、卸载、`list_bundles`、HMR 全部沿用现成机制。

## 格式一页速览

```
<name>-<version>.dpk          （zip；store + deflate，UTF-8 名，无 zip64，无加密）
├── dpk.json                  格式版本、身份、每个文件的 size+sha256、整体摘要
└── package/                  一个标准 DSH 包目录，逐字节原样
    ├── package.json          （必需）
    ├── cordis.patch.yml      bundle 角色的加载器补丁
    └── lib/ locale/ icon.svg README.md …
```

- 归档层限制：≤20000 条目、单文件 ≤64 MiB、总量 ≤512 MiB、压缩比 >200:1 拒绝、拒绝符号链接、
  拒绝仅大小写不同的路径、拒绝盘符/绝对路径/`..`（SPEC §5）。
- 完整性：逐文件 sha256 + `integrity.digest = sha256(files.map(f => `${path}\0${size}\0${sha256}`).join("\n"))`（SPEC §7）。
- 可复现：同目录两次 `pack` 产出**逐字节相同**的文件（zip 时间戳与 `createdAt` 都取固定时刻）。
- 严格性：`dpk.json` 顶层与 `files[]` 的未知字段一律拒绝，不做静默兼容（SPEC §9）。

## 本地仓库布局

```
$DSH_HOME/dpk/
  index.json                    dpk 的溯源账本（DSH 不读它）
  store/<digest>/package/       交给官方安装器的那个目录
  store/<digest>/dpk.json       归档清单副本，供事后审计
  archives/<name>-<ver>.dpk     --keep-archive 时的原始归档
```

内容寻址（目录名 = `integrity.digest`）带来的性质：同一 DPK 重复安装天然幂等；不同构建不会互相覆盖；
`index.json` 损坏也不影响已解包内容。

## 在 DSH 会话里安装

`dpk install` 需要能调用 DSH CLI。自动发现顺序是：`--dsh <cmd>` → `$DPK_DSH` → PATH 上的 `dsh`
→ 顺着 `$DSH_HOME/node_modules/@deepseek-ai`（或 profile 的同名联接）找回检出里的 `apps/cli/lib/bin.js`。

如果只想在会话内装，`--dry-run` 会直接把工具写法打出来：

```
plugin_manager action=install_bundle target=<store 里的绝对路径>
```

## 安全模型

- **完整性有，真实性没有**：DPK 能证明"内容自打包后未被改动"，不能证明"是谁打的包"。
  v1 没有签名（`dpk.json` 顶层出现 `signatures` 会被拒绝，字段名留给 v2）。
- 解包前逐路径校验 + 解包后 `realpath` 复核，双重防 zip slip。
- 四重炸弹护栏（条目数/单文件/总量/压缩比）。
- `verify` 不执行包内代码、不加载任何模块。

## 已知边界（都是刻意的，写清楚比藏着好）

1. **一个 DPK 只装一个包。** 套件请打成多个 DPK。多包归档（`packages/<name>`）留给 v2。
2. **带本地 `link:` 依赖的包不能单独分发。** 归档只携带一个包，其 `dependencies` 里
   `link:../sibling` 这样的相对目标在目标机器上不存在。本工作区的 `@local/dsh-reverse-skill`
   正是这种情况（它 `link:` 到 `@local/dsh-skill-dir`）。要分发这类包，二选一：
   把它做成自包含（把共享代码并进包内，参见 [examples/hello-bundle](examples/hello-bundle)），
   或者把被依赖的包也各自打成 DPK 并按顺序安装。
3. **补丁文件只做结构校验**：DPK 不实现 YAML 解析器，只证明 `cordis.patch.yml` 看起来是顶层数组；
   完整语义由 DSH 在挂载时校验（`verify` 输出里标为 `note`）。
4. **可执行位不承诺保留**：包内文件以 `0644` 写入 zip，Windows 源码树本来也没有 POSIX 权限。
5. **Node ESM 模块缓存的既有约束**：安装/替换包后要让**新的 JS 代次**生效，仍需重启 harness——
   这是 DSH 侧行为（见 harness 文档），DPK 不绕过。

## 目录

```
dpk/
  index.js                     DSH 插件入口：注册会话内 `dpk` 工具（零 harness 导入）
  cordis.patch.yml             bundle 层：插入 Loader 行 dsh-package-manager
  locale/{en,zh}.json          插件卡片文案（zh 标题即「DSH 安装包管理助手」）
  icon.svg                     插件卡片图标
  dpk.mjs                      CLI
  SPEC.md                      格式规范 v1（设计正本）
  README.md                    本文件
  lib/zip.mjs                  纯 Node zip 读写（store+deflate、CRC32、路径与限额校验）
  lib/dsh-package.mjs          DSH 包严格合规（逐条镜像 DSH 规则，带出处）
  lib/dpk-manifest.mjs         dpk.json 构造/校验 + 完整性摘要
  lib/pack.mjs                 pack
  lib/verify.mjs               verify（含深度合规复检）
  lib/store.mjs                内容寻址仓库 + 账本
  lib/install.mjs              解包 + 交接（CLI 或 pluginManager 服务）+ 记账
  lib/actions.mjs              动作层：CLI 与工具共用
  schemas/dpk-1.schema.json    dpk.json 的 JSON Schema
  examples/hello-bundle/       自包含示例包（零依赖）
  examples/dpk-hello-1.0.0.dpk 示例产物
  test/                        64 条测试（§12 一致性清单 + 动作层）
```

## 测试

```powershell
node --test
```

覆盖 zip 往返/可复现/CRC 篡改/路径攻击/加密/zip64/未知方法/炸弹护栏、DSH 合规的每一类拒绝、
清单严格性与摘要重算、以及安装的幂等、dry-run 只读、失败不留账本、`--force` 重建、
`--keep-archive` 留存。
