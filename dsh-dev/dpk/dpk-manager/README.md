# DSH 安装包管理助手（dpk）

`dsh-dpk-manager` —— 把**一个标准 DSH 包目录**打包成单个 `.dpk` 文件（本质是 zip），
并在本地可靠地安装它。它是一个**标准 DSH 插件**（`dsh.bundle.patch` + 中文标题的插件卡片 +
图标），按 DSH 桌面版插件的规范安装与更新，**不向系统注入任何命令**：

| 形态 | 入口 | 用法 |
| --- | --- | --- |
| 插件页面板 | `client.js` → 「本地 DPK」侧栏 | 导入 / 导出 / 卸载 `.dpk`，人点按钮即可 |
| 会话内工具 | `index.js` → 注册 `dpk` 工具 | 装进 profile 后，agent 可直接 `dpk action=verify/install/…` |

```text
dpk pack <目录>            校验 DSH 合规 → 写出 .dpk（同输入逐字节可复现）
dpk verify <文件.dpk>      结构 + 完整性 + DSH 合规
dpk install <文件.dpk>     验真 → 解到本地仓库 → 交给 DSH 自己的安装器
```

设计文档见 [SPEC.md](SPEC.md)（格式规范 v1，逐条可判定）；JSON Schema 见
[schemas/dpk-1.schema.json](schemas/dpk-1.schema.json)。

## 安装这个助手本身

它是普通 npm 包，就用 DSH 自己的插件页安装（与任何官方插件同一规范）：

DSH 桌面版 / Web → **插件** → **添加插件** → 填 `dsh-dpk-manager` → 安装。
更新同样走插件页。它不再提供 `dpk` 命令行，也不再把命令装进系统。

> **生效条件**：bundle 的 **config** 改动会热生效；但插件的 **JS 代码**改动不会——
> 宿主进程只会导入插件模块一次，之后一直用那一代（这与 DSH 自己的说明一致：
> 替换已安装的包需要重启才能加载新的 JS 代次）。所以首次安装或改了代码之后，
> 需要重启 Harness，会话内才会出现 `dpk` 工具、「本地 DPK」面板才挂上侧栏。

## 快速开始

- **安装一个 `.dpk`**：左侧栏 →「本地 DPK」→「导入 DPK 安装包」→ 选择 `.dpk` 文件。
  面板走的是与插件页完全相同的 `pluginManager` 服务，装完即出现在插件列表里。
- **覆盖安装**：导入已安装包的新版本直接升级（依赖行变化，走普通安装）；重复导入
  **同一版本**时官方安装器 diff 不到依赖变化、会答 `ambiguous-install`，dpk 此时自动
  改为「先卸载再安装」完成重装——两种情况导入即覆盖，无需先手动卸载。
- **打包**（对任意标准 DSH 包目录）：在 DSH 会话里让 agent 调 `dpk` 工具
  （`action=pack directory=… output=…`），或在构建脚本里编程调用
  `dsh-dpk-manager/lib/pack.mjs` 的 `packDirectory()`（库随包发布，`exports` 已导出）。
- **验真**：`dpk` 工具 `action=verify file=…`，不需要执行包内任何代码。

`install` 的输出会明确告诉你三件事：解到哪、谁装的、账本记在哪：

```
package  @local/dpk-hello@1.0.0 (bundle)
store    C:\Users\…\.dsh\dpk\store\<digest>\package
profile  dpk-demo (installed by the plugin manager service)
```

**先试后装**：工具的 `dryRun: true` 走完验真、算出确定性的 store 路径、打印等价的官方
调用，但**一个字节都不写**（不改 profile、不建 store、不记账）。

## 会话内工具 `dpk`

六个动作：`inspect`（只读清单）、`verify`（结构+完整性+DSH 合规）、`pack`（打进 `.dpk`）、
`install`（装进当前 profile）、`list`、`which`。

- 只有 `install` 会改 profile。它**先过沙箱提权判定**（`danger-full-access`，与官方
  `plugin_manager` 完全相同的请求与理由文本），再调用**同一个** `pluginManager` 服务；
  判定器或服务不可用时**一律拒绝安装**，并给出等价的
  `plugin_manager action=install_bundle target=<store 路径>` 调用。
- 本插件**不 import 任何 Harness 包**：`tools`、`sandboxPolicy`、`approval`、`pluginManager`
  全部经 `ctx` 服务拿；工具定义按 Harness 自己的参数 schema 形式手写，提权判定按
  `@deepseek-ai/dsh-sandbox#approveEscalation` 的规则与措辞镜像实现。这样一个 profile bundle
  在宿主自己的模块加载器下不会因为裸导入解析不到而失效，也让本包能作为 `.dpk` 自包含地分发。

## 为什么这样设计：它严格贴着 DSH 的标准

| DSH 的既有事实 | 出处 | DPK 的对应设计 |
| --- | --- | --- |
| 安装 spec 只认 `registry` / `path` / `git` / **`tarball`（仅 `.tgz`、`.tar.gz`）**；zip 会被判 `invalid-spec` | `packages/boot/plugin-manager/src/install-spec.ts:29,68-90` | `.dpk` 不冒充 spec：验真后**解包成目录**，再把**绝对路径**交给官方安装器（`kind: 'path'`） |
| 本地路径 spec 必须是绝对路径 | 同上 `:72-76` | store 用绝对路径寻址（`$DSH_HOME/dpk/store/<digest>/package`） |
| 插件页安装会跑 pnpm、写依赖，并在成功后把新 bundle 追加进 `dsh.profile.bundles` | `operations.ts:118,160`、`:78-96` | 导入只调用**同一个** `pluginManager` 服务（`installBundle`），**不自己写 profile、不自己跑 pnpm** |
| pnpm 的供应链冷却期（`minimumReleaseAge`）会在每次安装时复核 profile 里所有 registry 依赖 | pnpm 11 `minimumReleaseAge`/`minimumReleaseAgeStrict` | 导入前把 profile 的 `pnpm-workspace.yaml` 写上 `minimumReleaseAge: 0`（用户显式配置过的值永不改写）：`.dpk` 导入本身是用户明确发起且经摘要验真的安装，不应被刚发布的依赖拦下 |
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

## 安全模型

- **完整性有，真实性没有**：DPK 能证明"内容自打包后未被改动"，不能证明"是谁打的包"。
  v1 没有签名（`dpk.json` 顶层出现 `signatures` 会被拒绝，字段名留给 v2）。
- 解包前逐路径校验 + 解包后 `realpath` 复核，双重防 zip slip。
- 四重炸弹护栏（条目数/单文件/总量/压缩比）。
- `verify` 不执行包内代码、不加载任何模块。

## 已知边界（都是刻意的，写清楚比藏着好）

1. **本地分发的包自动归入 `@local/` 作用域**（如 `@local/zcode-provider`、`@local/dsh-reverse-skill`）。
   打包/安装遇到不带作用域的名字会**自动补上** `@local/`（归档清单、store 副本、patch 行名、账本一致生效；
   源目录本身不改）。loader 行 id 与模块自身的注册 id 不在自动改写之列——带 client 半区的包请让这些 id
   直接使用 scoped 名（`@local/zcode-provider` 是完整范例）。
2. **一个 DPK 只装一个包。** 套件请打成多个 DPK。多包归档（`packages/<name>`）留给 v2。
3. **带本地 `link:` 依赖的包不能单独分发。** 归档只携带一个包，其 `dependencies` 里
   `link:../sibling` 这样的相对目标在目标机器上不存在。要分发这类包，二选一：
   把它做成自包含（把共享代码并进包内，参见 [examples/hello-bundle](examples/hello-bundle)），
   或者把被依赖的包也各自打成 DPK 并按顺序安装。
4. **补丁文件只做结构校验**：DPK 不实现 YAML 解析器，只证明 `cordis.patch.yml` 看起来是顶层数组；
   完整语义由 DSH 在挂载时校验（`verify` 输出里标为 `note`）。
5. **可执行位不承诺保留**：包内文件以 `0644` 写入 zip，Windows 源码树本来也没有 POSIX 权限。
6. **Node ESM 模块缓存的既有约束**：安装/替换包后要让**新的 JS 代次**生效，仍需重启 harness——
   这是 DSH 侧行为（见 harness 文档），DPK 不绕过。

## 目录

```
dpk/
  index.js                     DSH 插件入口：注册会话内 `dpk` 工具（零 harness 导入）
  client.js                    「本地 DPK」侧栏面板（导入 / 导出 / 卸载）
  host-service.js              面板后端：Typert Remote 服务（dpk.* 四个方法）
  cordis.patch.yml             bundle 层：插入 Loader 行 dsh-dpk-manager
  locale/{en,zh}.json          插件卡片文案（zh 标题即「DSH 安装包管理助手」）
  icon.svg                     插件卡片图标
  SPEC.md                      格式规范 v1（设计正本）
  README.md                    本文件
  lib/zip.mjs                  纯 Node zip 读写（store+deflate、CRC32、路径与限额校验）
  lib/dsh-package.mjs          DSH 包严格合规（逐条镜像 DSH 规则，带出处）
  lib/dpk-manifest.mjs         dpk.json 构造/校验 + 完整性摘要
  lib/pack.mjs                 pack
  lib/verify.mjs               verify（含深度合规复检）
  lib/store.mjs                内容寻址仓库 + 账本
  lib/install.mjs              解包 + 官方服务交接 + pnpm 冷却期豁免 + 记账
  lib/profile-policy.mjs       profile 的 pnpm-workspace.yaml 冷却期豁免写入
  lib/actions.mjs              动作层：工具与面板共用
  schemas/dpk-1.schema.json    dpk.json 的 JSON Schema
  examples/hello-bundle/       自包含示例包（零依赖）
  examples/dpk-hello-1.0.0.dpk 示例产物
  test/                        70 条测试（§12 一致性清单 + 动作层）
```

## 测试

```powershell
npm test
```

覆盖 zip 往返/可复现/CRC 篡改/路径攻击/加密/zip64/未知方法/炸弹护栏、DSH 合规的每一类拒绝、
清单严格性与摘要重算、安装的幂等、dry-run 只读、失败不留账本、无安装器拒绝、
`--force` 重建、`--keep-archive` 留存，以及 pnpm 冷却期豁免的写入/保留/幂等。
