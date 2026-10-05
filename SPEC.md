# DPK — DSH 插件包格式规范 v1

> 状态：设计定稿（v1）
> 目标读者：打包者、安装器实现者、想审计 DPK 内容的人
> 参照实现：DeepSeek Harness `0.1.7-alpha.2`（一棵本地检出）

---

## 1. 定位

DPK（**D**SH **P**lugin **K**it）是一个 **zip 容器**，用来把**一个标准 DSH 包目录**完整、可校验地搬到另一台机器上安装。

三条不可动摇的原则：

1. **DSH 是唯一事实源。** DPK 不新增、也不放宽任何 DSH 的包规则。`package/` 里的内容必须原样就是一个 DSH 能装的包；DPK 只负责"怎么装进信封、怎么验真、怎么落地"。
2. **安装写的是 DSH 真正读的那三处，不经过 pnpm。** 安装动作默认由 DPK 自己完成：写 `<profile>/package.json` 的 `link:` 依赖行与 `dsh.profile.bundles`、建 `node_modules/<name>` 链接、补 `pnpm-lock.yaml` 的 importer 行 —— 这正是 Harness loader 与 `resolveBundleDir` 读取的全部内容（`packages/boot/app-boot/src/profile.ts:630`、`packages/boot/plugin-manager/src/operations.ts:89-111`）。pnpm 只是这四处的搬运工：它要求联网/registry 解析、每次启动进程、且在 bundle 运行时官方管理器拒绝 remove（`not-removable`）。需要官方机制时用 `via: "service"` 显式回到 `plugin_manager install_bundle`（或等价的 `dsh plugin --profile <p> install <abs path>`），由它跑 pnpm。
3. **可判定。** 每条规则都能用"通过/不通过"回答，不依赖人工判断；未知字段一律拒绝，不做"猜你想要什么"的兼容。

### 1.1 为什么必须"解包后再装"

DSH 的安装 spec 解析器（`packages/boot/plugin-manager/src/install-spec.ts:29`）只承认四种形态：

```ts
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
// kind: 'registry' | 'path' | 'git' | 'tarball'
```

- `.zip` / `.dpk` **不在其中**，直接把它交给官方安装器会被判为 `invalid-spec`；
- **绝对路径**是合法 spec（`kind: 'path'`，要求 `isAbsolute`）；
- 所以 DPK 的正确用法是：**验真 → 解包到本地仓库 → 让 profile 指向该目录**（默认自己写那三处；`via: "service"` 时把绝对路径交给官方安装器，官方照常 `pnpm add <abs path>`、照常把新 bundle 追加进 `dsh.profile.bundles`）。

两条路最终都留下同样形态的东西：profile 里是一条普通 `link:` 依赖、一个 `node_modules` 链接、一条 bundles 记录。DSH 完全不知道 DPK 存在，卸载、升级、`list_bundles`、HMR 全部沿用现成机制；区别只是"谁写的"和"要不要跑 pnpm"。

---

## 2. 文件命名

```
[<scope>-]<name>@<version>.dpk
```

- `@` 分隔名称与版本（与 npm 的 `name@version` 写法一致），避免连字符名称与版本边界不清；
- `<scope>` 去掉 `@`/`/`，例如 `@local/dsh-reverse-skill` → `local-dsh-reverse-skill@1.0.0.dpk`；
- 无 scope 的包 → `example-provider@1.0.0.dpk`；
- `name` / `version` 必须与 `dpk.json` 及 `package/package.json` 完全一致（大小写敏感）；
- 扩展名固定 `.dpk`，小写。文件名**不参与**校验（只作为人读线索），校验以 `dpk.json` 为准。

---

## 3. 归档布局（严格）

```
<name>-<version>.dpk
├── dpk.json                  # DPK 清单（唯一顶层元数据文件）
└── package/                  # DSH 包根目录，逐字节原样
    ├── package.json          # 必须存在
    ├── cordis.patch.yml      # bundle 角色的加载器补丁（若 dsh.bundle 声明）
    ├── lib/…  locale/…  icon.svg  README.md …
```

规则：

| 规则 | 说明 |
| --- | --- |
| 顶层只允许两项 | `dpk.json` 与 `package/`；出现任何其他顶层条目即拒绝 |
| `package/` 必须存在 | 且其中必须有 `package.json` |
| 归档内**恰好一个**包 | 一个 DPK 只装一个包；套件用多个 DPK |
| 目录条目可省略 | 解包器按文件路径隐式创建目录；出现目录条目时必须以 `/` 结尾且通过路径校验 |
| 空目录不保留 | zip 不承载空目录语义，不承诺保留 |
| 打包范围 | 包根下的**所有文件**，排除 `node_modules/`、`.git/`、`dist/` 与 `dpk-dist/` 四个目录（依赖树、版本库元数据、构建产物）；不解释 npm 的 `files` / `.npmignore`（DPK 做内容忠实打包，不做发布裁剪），且拒绝符号链接与特殊文件 |

`package/` 前缀的两个理由：与 npm tarball 的 `package/` 约定一致；给将来的同级扩展（`signature/`、`docs/`）留位置，同时避免包内文件与 DPK 元数据重名。

---

## 4. `dpk.json`

### 4.1 示例

```json
{
  "dpk": 1,
  "name": "@local/dsh-reverse-skill",
  "version": "1.0.0",
  "createdAt": "2026-09-25T12:00:00.000Z",
  "generator": "dpk/2.1.12",
  "entry": "package/package.json",
  "roles": ["bundle"],
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=20" },
  "peerDependencies": { "@deepseek-ai/dsh-skill": "*" },
  "files": [
    { "path": "package/package.json", "size": 698, "sha256": "9f2c…" },
    { "path": "package/index.js", "size": 965, "sha256": "1a04…" }
  ],
  "integrity": { "algorithm": "sha256", "digest": "3b7e…" }
}
```

### 4.2 字段表

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `dpk` | integer | ✅ | 格式版本，本规范为 `1`。大于实现支持值时拒绝（"更新的 DPK 版本"），不猜测 |
| `name` | string | ✅ | 必须等于 `package/package.json` 的 `name`；须匹配 npm 包名文法（见 §6.1）。归档携带包的**本名**；`@local/` 作用域是**安装期标识**，由 dpk 在安装动作里加到 store 副本、patch 行、台账与数据卷根上，pack 阶段不写入任何作用域 |
| `version` | string | ✅ | 必须等于 `package.json` 的 `version`；须为 semver |
| `createdAt` | string | ✅ | RFC 3339 / ISO 8601 UTC，用于溯源；**不参与**完整性计算。默认取可复现时刻 `1980-01-01T00:00:00.000Z`，`--created-at now` 才写真实构建时间（见 §5 可复现性） |
| `generator` | string | ✅ | `<tool>/<version>`；版本部分必须等于写出该归档的 dpk 实现版本（不是常量）。校验失败时读取方据此报出"归档由谁写出、当前读取器是谁"，跨机器排错靠它对齐两端。不参与摘要（§7.3） |
| `entry` | string | ✅ | 固定 `"package/package.json"` |
| `roles` | string[] | ✅ | 取值 `bundle`/`client`/`plain`，由 `package.json` 派生（§6.2）；非空 |
| `dsh` | object | ❌ | `package.json` 的 `dsh` 字段原样副本，便于不打开包就看清它是 bundle 还是纯依赖 |
| `engines` | object | ❌ | `package.json.engines` 副本 |
| `peerDependencies` | object | ❌ | 副本；安装前的预检信息（DPK 只提示，不做依赖求解） |
| `files` | array | ✅ | 覆盖 `package/` 下**每个文件**（不含目录），按 `path` 升序 |
| `files[].path` | string | ✅ | 归档内路径，以 `package/` 开头，`/` 分隔 |
| `files[].size` | integer | ✅ | 未压缩字节数，≥0 |
| `files[].sha256` | string | ✅ | 64 位小写十六进制 |
| `integrity` | object | ✅ | 见 §7 |

**未知字段一律拒绝**（含 `dpk.json` 顶层与 `files[]` 元素内）。要加字段就升 `dpk` 版本。

---

## 5. 归档层规则

DPK 是**标准 zip**，可以被任何 zip 工具读取（`unzip -l`、`tar -tf`、资源管理器等）。为可移植与可判定，规范收紧如下：

| 项 | 规定 |
| --- | --- |
| 压缩方法 | 仅 `0`（store）与 `8`（deflate）；其他方法（bzip2/lzma/zstd）拒绝 |
| 加密 | 禁止（通用位标记 bit0 必须为 0） |
| zip64 | 禁止；条目数 ≤ 20000，单文件 ≤ 64 MiB，总解压 ≤ 512 MiB |
| 文件名编码 | UTF-8，必须置 bit11（EFS）；文件名按 UTF-8 严格解码 |
| 路径分隔 | 只用 `/`；禁止 `\`、盘符（`C:`）、前导 `/`、`.`/`..` 段、NUL、空段 |
| 大小写碰撞 | 拒绝；同一归档内不允许出现仅大小写不同的路径（Windows 解包会互相覆盖） |
| 重复路径 | 拒绝 |
| 符号链接 | 禁止（unix 模式含 `S_IFLNK` 即拒绝）；本规范不支持归档内链接 |
| CRC32 | 每个条目必须与内容一致，解包时校验 |
| 时间戳 | 打包时默认写成固定时间 `1980-01-01 00:00:00`（DOS epoch），使**同一输入产出逐字节相同的 DPK**；`--timestamp <ISO>` 可覆盖 |
| 条目顺序 | 按路径字节升序写入，保证可复现 |
| 压缩比 | deflate 单条目压缩比 > 200:1 拒绝（zip 炸弹护栏） |
| 目录条目 | 可省略；若存在必须 `/` 结尾且 external attrs 标记目录 |
| 权限位 | 文件 `0644`、目录 `0755`（Windows 无 POSIX 权限，可执行位不承诺保留） |

**可复现性**：`pack` 对同一目录两次产出的 DPK **逐字节相同**。为此 zip 时间戳与 `dpk.json.createdAt` 都取固定时刻；需要记录真实构建时间时显式 `--created-at now`，那时代价是失去逐字节可复现（内容摘要 `integrity.digest` 不受影响，仍然相同）。

---

## 6. DSH 包合规校验（`package/` 内）

DPK 的"严格"体现在这里：以下规则**逐条镜像 DSH 自己的读取逻辑**，DPK 不额外发明要求，但会提前把 DSH 会拒绝的东西挡下来。

### 6.1 `package.json` 基础

| 规则 | DSH 出处 |
| --- | --- |
| `package/` 内不得出现 `.dpk` 文件：归档不是内容；打包与校验一律拒绝（`PACKAGE_NESTED_ARCHIVE`），历史归档在导入时由 store 剥离 | DPK 规范自身约定（防嵌套归档事件） |
| `name` 匹配 `^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$` 且 ≤214 字符 | `install-spec.ts:31-32` |
| `name` 不带作用域是**常态**：归档携带本名，`@local/` 由**安装动作**添加（`localizeStoredPackage` 改写 store 副本与 patch 行，台账与数据卷根随之）：DPK 是本地分发格式，安装后的名字统一为 `@local/<本名>`，本地包不得遮蔽 registry 上的公共名；源目录与归档本身永不被改写或预烧作用域（2.1.10 之前打包器曾在 pack 期改写，属分层颠倒，已修正） | DPK 规范自身约定 |
| `version` 为非空 semver | `dsh-package-manifest` 的 `DshPackageManifest.version` |
| `private`、`description`、`license`、`repository` | 可选，类型正确即可 |
| `engines.dsh` / `engines.node` 为字符串 | `types.ts:57-66` |

### 6.2 角色判定

按 `package.json` 自动判定，写入 `dpk.json.roles`：

| 条件 | 角色 |
| --- | --- |
| `dsh.bundle.patch` 存在（string 或 string[]，均须为非空、非绝对、留在包内、存在） | `bundle` |
| `dsh.client` 存在 | `client` |
| 两者都没有 | `plain`（纯依赖；DPK 允许，安装后不进 bundles 列表） |

`dsh.manifestVersion` 若出现必须为 `1`。

### 6.3 bundle 补丁文件

- `dsh.bundle.patch` 的每个路径相对包根解析、`realpath` 后必须仍在包内；
- 文件必须存在、非空、扩展名 `.yml`/`.yaml`；
- **结构检查**：顶层必须是 YAML 数组（每个 `-` 起始的非空行），插入行若带 `name` 必须是字符串。完整语义校验交给 DSH 加载器——DPK 不实现 YAML 解析器，这一条在 `verify` 输出中标注为 `structural-only`。

### 6.4 `dsh.client`（若存在）

| 字段 | 约束 | 出处 |
| --- | --- | --- |
| `platform` | 非空字符串 | `types.ts:81-83` |
| `immediately` | 布尔 | 同上 |
| `inject` | 字符串数组 | 同上 |
| `external` | 字符串数组 | 同上 |

### 6.5 展示元数据（镜像 `package-meta.ts`）

| 规则 | 出处 |
| --- | --- |
| `icon` 必须是**相对**路径（拒绝绝对路径、`win32` 绝对路径、带 scheme 的 URL） | `package-meta.ts:24-26` |
| 扩展名 ∈ `.svg/.png/.jpg/.jpeg/.webp` | `package-meta.ts:16-19,27-28` |
| `realpath` 后仍在清单目录内、且为普通文件 | `package-meta.ts:29-36` |
| 字节数 ≤ 256 KiB | `package-meta.ts:15,37-39` |
| 若提供本地化文案：`locale/<lang>.json` 中 `meta.title` / `meta.description` 为非空字符串 | `package-meta.ts:101-122` |
| `<lang>` 匹配 `^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$` | `package-meta.ts:10` |

`locale/en.json` 缺失时 DSH 会回退到 `package.json` 的 `name`/`description`；DPK 只在缺失时给 **warning**，不算失败。

### 6.6 不做的事（明确划界）

- 不校验 `exports` 的解析结果（DSH 的 `resolveBundleDir` 明确不要求导出 `./package.json`）；
- 不校验 peer 依赖是否可满足（不做依赖求解）；
- 不校验 `cordis.patch.yml` 里插件 `config` 的 schema（那需要真的激活插件）；
- 不执行包内任何代码（与 DSH 读元数据时"不 eval 插件代码"的立场一致）。

---

## 7. 完整性

### 7.1 逐文件

`files[]` 覆盖 `package/` 下所有文件，给出 `size` 与 `sha256`（内容，不含 zip 头）。解包时逐项比对。

### 7.2 整体摘要 `integrity.digest`

对**规范化清单行**做 SHA-256：

```
digest = sha256( join("\n", files.map(f => `${f.path}\0${f.size}\0${f.sha256}`)) )
```

- `files` 必须先按 `path` 的 UTF-8 字节序升序排列；
- 行内分隔用 `\0`，行间用 `\n`，**末尾不加换行**；
- 算法名写在 `integrity.algorithm`，v1 固定 `sha256`。

这个摘要同时被用于本地仓库的目录名（§8.2），因此"同一份 DPK"在两个地方必然得到同一个路径。

### 7.3 不覆盖的范围

`createdAt`、`generator`、zip 时间戳**不参与**摘要——它们是来源信息，不是内容。签名（数字签名）在 v1 中**未定义**；`dpk.json` 顶层预留字段名 `signatures`，v2 再定，v1 出现该字段即拒绝。

摘要只覆盖 `files[]`，即 `package/` 下的内容，**不覆盖 `dpk.json` 自身**。因此清单被改写（例如凭空加一条数据卷声明）不会让摘要失配，拦住它的是 §8.1 第 2 步的交叉校验：清单的每一项声明都必须与 `package/package.json` 的实际事实相符。

交叉校验**比较声明而不是比较文本**：对象键的顺序、数据卷在列表中的顺序、路径末尾的斜杠都只是书写形式，两侧先经同一套规范化（含按 `id` 排序）再比对——同一份声明的不同写法必须得到同一个结论。校验失败时报出具体是哪一条声明、哪个卷不一致。

---

## 8. 安装语义

### 8.1 流程

```
1. 读文件 → zip 结构校验（§5）
2. 读 dpk.json → 字段校验（§4）→ 与 package/package.json 交叉校验（§6）
3. 逐文件 sha256/size 比对 + integrity.digest 重算（§7）；深校验与解包合成一次解压
4. 解包到 <home>/dpk/store/<digest>/package/  （先写临时目录，再原子改名）
5. 物化受管数据卷（§13）：先全量校验声明与种子，再统一写入
6. 让 profile 指向该目录（提交点，见下）：
       via=profile（默认）  自己写四处：依赖行 link:<abs path>、dsh.profile.bundles、
                            node_modules/<name> 链接、pnpm-lock.yaml 的 importer 行
                            顺序固定为 **链接 → 依赖行/bundles → lockfile 行**（见下）
       via=service          交给官方安装器：
                            plugin_manager action=install_bundle target=<abs path>   （会话内）
                            dsh plugin --profile <p> install <abs path>              （命令行）
                            由它跑 pnpm 完成同样的四处写入
7. 记录到 <home>/dpk/index.json（DPK 侧的溯源账本，DSH 不读它；只记 dpk 放过哪些 digest，不记谁在用）
```

**提交点是第 6 步，所以它排在最后。** 受管数据卷在第 5 步先就位，看起来与 dpkg 的
"先解包、后放 conffile"相反，理由是：dpk 的 profile 写入才是 loader 下次启动真正读的东西，
它不能在"这个版本声明要用的文件还不存在"的时候变得可见。按这个顺序，一个物化不出来的卷
会让安装**原地中止**——profile 一个字没改，上一版继续完整可用——而不是留下一个指向
"声明了却从没落地的文件"的新版本的 profile。

第 6 步的顺序是**故障后果**决定的，不是实现便利决定的：loader 先读依赖行，一条指向解析不到的
`node_modules/<name>` 的依赖行会在下次启动时让 profile 起不来；而一个没有依赖行的链接只是不被加载。
因此 link 先写、依赖行后写，中间崩溃留下的残余一定是无害的那一种，重跑安装即收敛。

任一步失败即中止，且**不留下半装状态**：第 4 步之前失败不改动文件系统；第 4 步用"临时目录 + 改名"保证原子性；
第 5 步的校验先于任何写入，所以声明不满足时数据卷一个字节都不写；第 6 步的 profile 写入先落到
`package.json` 的临时文件再改名，失败时 profile 仍是原样（链接与 lockfile 行各自幂等，且链接先于依赖行写）。
第 4 步之后、第 7 步之前失败时，**本次调用刚落下的 store 副本会被撤掉**（仅当没有任何 profile 解析它——
digest 是内容寻址，别的 profile 可能早已装过同一份，那份必须留下）。

### 8.2 本地仓库布局

```
$DSH_HOME/dpk/
  index.json                       # 溯源账本：{ entries: [{name, version, digest, installedAt, source, live?}] }（谁在用读 profile；`live: true` = 已由官方服务应用到本进程）
  store/<digest>/package/          # 解包后的包根（profile 的 link: 目标）
  cache/                           # 唯一的事务暂存区，见下
```

`store/` 里只有 digest 目录，别的一律不是 dpk 的：历史世代在自己目标旁边留下的暂存物（dpk ≤ 2.1.43 的
`<digest>.tmp-…`）**见到即删**，不判断其写入者是否还活着——那些世代不在服务范围内；而不符合暂存命名约定的
名字（别人的文件）既不删也不报错。

#### `cache/` 的生命周期

每一次写入都是"暂存 → 改名发布"，四个暂存物全部住在 `cache/`：

| 事务 | 暂存物 | 发布目标 | 原子性 |
| --- | --- | --- | --- |
| store 落位 | `cache/<digest>.tmp-<pid>-<n>/` | `store/<digest>/` | 目录改名 |
| reinstall 让位 | `cache/displaced-<digest>.tmp-<pid>-<n>/` | 换完即删 | 目录改名 |
| 账本写入 | `cache/index.json.tmp-<pid>-<n>` | `dpk/index.json` | 文件改名 |
| profile 清单 | `cache/manifest-<profile>.dpk-<pid>-<n>` | `profiles/<p>/package.json` | 文件改名 |

规则四条：

1. **创建与收尾**：写入者按需创建（`mkdir`）；改名成功后若 `cache/` 已空，写入者自己把它删掉。稳态的
   dpk 根目录只有 `store/` 与 `index.json`。
2. **收集**：只有 `autoremove`。判据是**名字里的 pid 是否已消失**——活写入者的暂存物谁都不得碰；
   名字里没有 pid 的条目不属于 dpk（未来的世代或别人的文件），一律不动。
3. **`store/` 只放 digest**：见上。
4. **崩溃残留**：抽取中崩 → `cache/` 里的暂存物（`autoremove`）；改名后、写 profile 前崩 → 无引用的
   store 目录（`autoremove`）；写 profile 后、记账前崩 → `list` 报 `untracked`，重装即记账。

因为暂存与目标现在跨目录改名，`<home>/dpk/cache` 必须与 `store/`、`profiles/` 同处一个文件系统
（默认都在同一个 `<home>` 下）；跨不过去会直接报错，不会退化成非原子的复制。

内容寻址（`store/<digest>/`）带来三件事：同一 DPK 重复安装天然幂等；不同版本/不同构建不会互相覆盖；`index.json` 损坏也不影响已装内容。

**不变式：store 里的 digest 集合 = 被某个 profile 引用的 digest 集合。** "被引用"的判据有两处，都读：
profile `package.json` 里的 `link:` 依赖行，以及 `node_modules/<name>` 链接经 `realpath` 解析出的目录——
后者是文件系统事实，不需要解析 JSON，所以 manifest 被改坏或写到一半也藏不住"正在用的副本"。

谁负责收敛这条不变式，按动词划分，**不做跨动词的全量清扫**：

| 动词 | 回收范围 |
| --- | --- |
| `remove` | 只回收该 profile 刚放手的那**一个** digest（`store` 行显示 `kept`/`dropped`） |
| `upgrade` | 只回收本次升级替换掉的**一个** digest（每行一个） |
| `autoremove` | 全量回收：无人引用的 digest（含只有目录、账本里没有记录的孤儿）、被中断写入的暂存物 |

全量清扫只属于 `autoremove`——它的整个语义就是回收。安装/卸载一个包时顺手做全量清扫会删掉用户从未提及的包
的副本（实测：升级 A 会把无人引用的 B 一起删掉），已修。两个定点回收动作**fail-closed**：只要有任一 profile 的
`package.json` 读不出来，就无法证明候选 digest 无人使用，此时一个字节都不删，只报告是哪个 profile 挡住了。

`upgrade` 的候选在**尝试之前**就登记：一次升级可能先把 profile 改指到新版本、随后在物化数据卷时失败，
此时旧副本已经成了孤儿，必须一并清掉；而如果失败发生在改指之前，旧副本仍被该 profile 引用，定点回收会
自己判定为 `kept`。所以"失败的那一行"不会留下任何多余副本，也不会删掉活着的副本。

账本只记"dpk 何时从哪个来源放过这个 digest"，不记"谁在用"——早期两处都记，结果账本那份永远只增不减，
与实际安装状态说了两套话。

### 8.3 便捷性承诺

- `dpk install x.dpk` 默认读 `DSH_PROFILE`（无则 `default`），无需手写 profile 名；`name=` 接受包本名
  （`example-provider`）与安装后的作用域名（`@local/example-provider`）两种写法，两者指同一个包；
- `dpk remove` 在目标 profile 本来就没装该包时报错，并列出它实际持有的依赖——空操作绝不输出"已卸载"；
- `dpk verify x.dpk` 可在无 DSH 的机器上跑（纯 Node，无依赖）；
- `dpk update` 报告哪些已装包有更新可用（只读：扫账本记下的来源目录），`dpk upgrade` 装上它们。

---

## 9. 版本演进

**只服务当前世代，不向后兼容。** 旧世代的归档、布局与残留一律拒绝或直接删除，不做静默迁移，
也不为它们保留分支——需要旧内容时，用能读懂它的那一版工具导出，再由当前版本导入。

| 场景 | 行为 |
| --- | --- |
| `dpk` 小于等于实现支持 | 正常处理 |
| `dpk` 大于实现支持 | 拒绝，提示升级 dpk 工具 |
| 出现未知字段 | 拒绝（v1 规则） |
| 本版本不再认识的旧写法 | 拒绝（**没有**迁移提示——那个世代不在服务范围内） |
| `store/` 里旧世代的暂存残留 | 见到即删（不判断其写入者是否还活着） |
| `store/<digest>/dpk.json` 边车 | 见到即删（pre-2.0.3 遗留，无人读） |
| 账本里出现早期字段（`path`/`profiles`） | 原样保留，不改写：那属于本版本不服务的世代 |
| `.dpks` 清单内联 base64（2.1.35–2.1.36） | 拒绝：只认"清单列路径、内容在 `data/` 条目"这一种形态 |
| 打包期烧入 `@local` 的归档、`dist/` 入包的归档 | 交叉校验直接判不匹配 |
| 旧类名（`config`/`state`/`cache`）声明与旧类名目录 | 声明报错；旧目录不读、不搬迁 |
| 加字段 | 升 `dpk` 到 2，并在实现中同时支持 1 与 2 |

`generator` 的版本部分随实现发布递增（§4.2），它是同一个 `dpk: 1` 之下区分语义年代的线索：归档带着
自己世代的 `generator`，而读取端只认当前世代的语义，所以两侧版本不同时先对齐工具版本再谈包本身有没有问题。

---

## 10. 安全考量

| 风险 | 处置 |
| --- | --- |
| zip slip（`../` 逃逸） | 解包前逐路径校验；解包后校验 `realpath` 仍落在目标目录内 |
| zip 炸弹 | 条目数/单文件/总量/压缩比四重上限 |
| 大小写碰撞覆盖 | 拒绝仅大小写不同的路径 |
| 符号链接逃逸 | 禁止归档内符号链接 |
| 元数据欺骗 | `dpk.json` 与 `package.json` 的 name/version 必须一致；文件清单覆盖全部文件，多一个少一个都拒绝 |
| 供应链 | v1 无签名：DPK 提供**完整性**（内容未被改动），不提供**真实性**（谁打的包）。分发渠道的可信度仍由渠道负责；`signatures` 字段留给 v2 |
| 执行代码 | `verify`/`show` 不执行包内任何代码、不加载包内任何模块 |

---

## 11. 与相关机制的关系

| 机制 | 关系 |
| --- | --- |
| npm tarball（`.tgz`） | `.tgz` 本来就能被 `pnpm add` 直接吃下（`TARBALL_SPEC`），但它没有 DSH 侧的合规预检，也不固定内容布局。DPK 走 zip + 强校验，安装前即可判定"这是不是一个合法的 DSH 包" |
| `dsh plugin install <path>` | DPK 的解包产物就是它的合法入参 |
| `plugin_manager install_bundle` | `via: "service"` 时的等价入口：官方实现跑 pnpm 并完成同样的四处写入 |
| profile 的 `cordis.patch.yml` | DPK 不碰它；用户层的覆盖仍在 profile 里做 |
| HMR | 装与卸都由 DPK 调官方服务的 `setBundleEnabled` 请求实时生效（一次 reconcile，不跑 pnpm）：live profile 立刻 `applied`，否则答 `restart-required`。装与卸是同一个调用、两个方向；DPK 自己从不重启任何东西，也不把一种答案说成另一种 |

---

## 12. 一致性测试清单（实现必须覆盖）

1. zip 往返：写 → 读 → 内容与 CRC 一致；`unzip -t` 独立复核通过。
2. 可复现：同目录两次 `pack` 产出逐字节相同。
3. 篡改：改 `package/` 内任一字节、增删一个文件、改 `dpk.json` 的 size/sha256/digest → `verify` 全部失败。
4. 路径攻击：`../x`、`/x`、`C:\x`、`a\\b`、大小写碰撞、重复路径 → 全部拒绝。
5. 归档攻击：加密位、zip64、未知压缩方法、超大压缩比 → 全部拒绝。
6. DSH 合规：非法包名、缺 `version`、`dsh.bundle.patch` 指向不存在文件、icon 越界/超 256 KiB、`dsh.client.platform` 缺失 → 全部失败；合法包全部通过。
7. 角色判定：bundle / client / plain 三种包的 `roles` 正确。
8. 安装：真实安装后 `store/<digest>/package` 存在、`index.json` 记录正确、profile 四处（依赖行/`dsh.profile.bundles`/`node_modules` 链接/lockfile 行）都指向该目录。
9. 幂等：同一 DPK 装两次不产生第二个 store 目录。

---

## 13. 受管数据卷（dpkg 语义）

一个包的**持久文件**通过 `package.json` 的 `dsh.data.volumes` 声明一次，dpk 据此（且仅据此）物化、升级与清除它们——安装全程不执行包内任何代码，插件在 dpk 给出的路径上读写自己的文件。

### 13.1 声明

```json
"dsh": {
  "data": {
    "volumes": [
      { "id": "providers",        "class": "data", "path": "providers.json", "seed": "seeds/providers.json" },
      { "id": "credentials",      "class": "app",  "path": "credentials.json" },
      { "id": "captcha-profile",  "class": "app",  "path": "captcha-profile/cookies" }
    ]
  }
}
```

| 字段 | 约束 |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]*$`，包内唯一 |
| `class` | `data` / `app` 二选一。**破坏性变更**:更早的类名(`config`≤2.1.29、`state`/`cache`≤2.1.25)被**拒绝**——报错指出当前写法,包作者改声明后重新打包即可 |
| `path` | 卷内相对路径（可嵌套）；拒绝绝对路径、盘符、`..`、反斜杠；包内唯一 |
| `seed` | 可选；包内文件路径，安装期作为卷的初始内容物化 |

两类卷的差别只有**迁移**，落位、种子代际与 purge 行为完全一致：

| class | 含义 | 迁移 | 生命周期 |
| --- | --- | --- | --- |
| `data` | 包声明的持久文件（通常由 `seed` 产生）：声明本身就是它的来源 | ❌ 不随 `export` 携带——换机时由声明重建 | remove 保留，purge 删除 |
| `app` | 包在运行期自己写下的东西：会话、凭证、派生数据 | ✅ `export` 携带 | remove 保留，purge 删除 |

**类名历史（全是破坏性变更）**：`config`（≤2.1.29）→ `data`；`state`/`cache`（≤2.1.25）→ `app`；更早的
三分（借 XDG 的分类）已废弃——`state` 与 `cache` 合并进 `app`，于是"包自己写下的一切"作为一类随 `export` 走。

旧类名**声明报错**，旧类名目录（`config/…`、`state/…`、`cache/…`）**不读、不搬迁**：那些目录属于本版本
不服务的世代，其中的文件原样留在磁盘上，既不进新卷也不被删除。要保留它们的内容，由使用者自己搬进
当前声明的类目录——dpk 不做这条迁移。

### 13.2 多包数据文件（dpks）

`dpk export all` 打包出 **`.dpks` 归档**（zip，与 `.dpk` 同规则；默认写到工作目录的 `dpks.dpks`，`snap all` 则为 `snap.dpks`）。归档内容：

```
dpks.json                              # 清单:{format:"dpks-data/1", exportedAt, packages:[{package, files:[{path}]}]}
data/<package>/<class>/<file>          # 每个包携带的卷,按原路径平铺,内容只在这里出现一次
```

**清单只列路径，内容只在 `data/` 条目里**：一个卷的字节不该在同一个文件里存两遍，而 base64 放进 JSON 又会比原文件大三分之一。写入端因此不再把 `files[].bytes` 写进 `dpks.json`。

读取端**按内容判断形态**：文件名以 `.dpks` 结尾，或文件以 zip 本地头签名（`PK\x03\x04`）开头，就走归档路径（`readZipIndex`/`readZipEntry`），否则按单包 JSON 解析，因此 `.dpks` 被改名也照样导入。但**只认一种内容布局**：清单列路径、内容在 `data/` 条目里。清单内联 base64 的那种（2.1.35–2.1.36 写过）不被读取，直接报"归档没有这个文件的内容"。

`dpk import` 逐包写回——本机未记录的包**跳过并提示**（先安装再重新导入），`name=` 可从归档里挑一个包导入。单包文件（`dpk-config-data/1`）继续可用。

### 13.3 布局与所有权

```
<home>/data/<scope>/<name>/<class>/<path>     # 卷内容(插件读写)
<home>/data/<scope>/<name>/.dpk/<id>.seed.json  # dpk 私有:该卷来自哪个种子代
```

目录名由包名派生（带 scope 目录，`@local/pkg` → `data/@local/pkg`），包不写死路径。`.dpk/` 是管理器私有区，插件不得读写。

**动词管类，作用域管包数。** 两个动词各带一条作用域轴，四条组合因此只是两次选择：

| | `name=<包>` | `all: true` |
| --- | --- | --- |
| `export`（仅 `app`） | 单包 JSON（`dpk-config-data/1`） | `.dpks` 归档（`dpks-data/1`） |
| `snap`（`app` + `data`） | 单包 JSON | `.dpks` 归档 |

容器不区分动词：读取端认两种文件、也不问它出自哪个动词，区分只在携带的类。

**形态随内容。** 一个包 = 单包 JSON（`dpk`），两个及以上 = `.dpks` 归档；`dpk pkg` 的增/删会让文件在这
两个形态之间迁移，扩展名跟着改（`.json` ↔ `.dpks`），旧名删除。因此读取端（`lib/data-file.mjs`）不只看
文件名或清单里的 `format`：带 `packages` 数组的文档按多包读，单包文档里带了 `package` 字段的条目以条目为准
——手写文件写着单包却列了多个包，也照样读。

条目一律带 `<class>/` 前缀。同一相对路径**允许**同时声明在两类下（两类目录各自成根），所以导入先按
"类 + 路径"精确匹配，认不出时才退到按路径匹配（覆盖包在版本之间把某个卷换了类的情况）。

### 13.4 生命周期（逐条对齐 dpkg）

| 事件 | 行为 |
| --- | --- |
| 首次安装 | 带 `seed` 的卷把种子内容物化到卷路径并记录种子摘要；无 `seed` 的卷**什么都不写**——目录由插件首次写入时诞生 |
| 升级安装 | 卷已存在且与记录的种子摘要一致（或等于新种子）→ 原地刷新为新种子；与种子不一致（用户改过）→ **保留本地文件**，新种子写到旁边 `<name>.dpk-new`（dpkg 的 conffile 规则）；没有种子标记的既有文件 → 视为用户数据收编（`adopted`），绝不覆盖 |
| 重复安装同版本 | 同"升级"；用户改动永远存活 |
| remove（卸载包） | 卷全部保留 |
| purge（`dpk purge`） | 删除整个 `data/<scope>/<name>`（data、app 与标记一起） |
| 导出/导入 | `export` 只携带 **app 卷**（`name=` 一个包 / `all` 全部包）；`snap` 携带 **app + data**（同样两种作用域）；导入按包**当前声明**落位（类前缀只是导出记录）；落地为**用户数据**（不留种子标记，永不静默覆盖）；携带未声明的文件 → 拒绝 |
| `pkg` | 对一个数据文件做增删改查：`op=list` 只读列出；`add` 把一个**已装**包并入（已在文件里则刷新该条目）；`remove` 删掉一个包；`set`（改）把文件记录的那个**包名**改成 `to=`（卷字节不动，归档条目路径随之改名），新名本机没装也可以。`remove`/`set` 的 `name` 匹配**文件里的**包名（可带/不带 scope），因此别的机器做的文件也能整理；`add` 才读账本。写入先写同名 `.tmp-<pid>-1` 再改名，形态变了连扩展名一起改并删掉旧名 |

### 13.5 校验

- 声明在 `pack` 时严格校验（id/class/path 文法、唯一性、seed 存在且在包内、seed ≤ 1 MiB、卷数 ≤ 64），且**仅**随 `dpk.json` 的 `dsh` 逐字副本携带（2.1.8–2.1.9 曾另写一份顶层 `data` 副本，因白名单读取端整包拒收，已于 2.1.10 移除；顶层 `data` 现为未知字段，读到即拒，报错会点明这是旧写法、重打包即可）；
- `verify` 对 `dsh.data` 副本再跑同一套校验，且与 `package/` 内声明的**规范化结果**交叉比对，不一致即拒绝并点出是哪个卷；
- `pack` 在写出归档前跑**与 `verify` 相同的**交叉校验，因此"自己打得出"蕴含"装上一定过校验"。这条不变式把"打包端与导入端规则不一致"的缺陷挡在打包时，而不是留到另一台机器上才暴露；
- `install` 在** profile 指向该包之前**物化卷，且先全量校验再统一写入（§8.1）：声明不满足时数据卷一个字节都不写，
  profile 一个字不改，上一版继续可用——不留半装状态。
