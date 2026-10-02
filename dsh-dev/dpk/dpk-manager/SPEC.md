# DPK — DSH 插件包格式规范 v1

> 状态：设计定稿（v1）
> 目标读者：打包者、安装器实现者、想审计 DPK 内容的人
> 参照实现：DeepSeek Harness `0.1.7-alpha.2`（检出 `C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\dsh-dev\deepseek-harness`）

---

## 1. 定位

DPK（**D**SH **P**lugin **K**it）是一个 **zip 容器**，用来把**一个标准 DSH 包目录**完整、可校验地搬到另一台机器上安装。

三条不可动摇的原则：

1. **DSH 是唯一事实源。** DPK 不新增、也不放宽任何 DSH 的包规则。`package/` 里的内容必须原样就是一个 DSH 能装的包；DPK 只负责"怎么装进信封、怎么验真、怎么落地"。
2. **不绕过官方安装链路。** 安装动作最终仍由 DSH 自己的安装器执行：把解包出来的**绝对路径**交给 `plugin_manager install_bundle`（或等价的 `dsh plugin --profile <p> install <abs path>`）。DPK 工具**不**自己去写 `package.json` 的依赖、**不**自己调 pnpm。
3. **可判定。** 每条规则都能用"通过/不通过"回答，不依赖人工判断；未知字段一律拒绝，不做"猜你想要什么"的兼容。

### 1.1 为什么必须"解包后再装"

DSH 的安装 spec 解析器（`packages/boot/plugin-manager/src/install-spec.ts:29`）只承认四种形态：

```ts
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
// kind: 'registry' | 'path' | 'git' | 'tarball'
```

- `.zip` / `.dpk` **不在其中**，直接把它交给安装器会被判为 `invalid-spec`；
- **绝对路径**是合法 spec（`kind: 'path'`，要求 `isAbsolute`）；
- 所以 DPK 的正确用法是：**验真 → 解包到本地仓库 → 把该目录的绝对路径交给官方安装器**。官方随后照常 `pnpm add <abs path>`、照常把新 bundle 追加进 `dsh.profile.bundles`（`packages/boot/plugin-manager/src/operations.ts:78-96`）。

这样做的收益：安装后 profile 里记录的是普通 `link:`/`file:` 依赖，DSH 完全不知道 DPK 存在，卸载、升级、`list_bundles`、HMR 全部沿用现成机制。

---

## 2. 文件命名

```
[<scope>-]<name>-<version>.dpk
```

- `<scope>` 去掉 `@`/`/`，例如 `@local/dsh-reverse-skill` → `local-dsh-reverse-skill-1.0.0.dpk`；
- 无 scope 的包 → `zcode-provider-1.0.0.dpk`；
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
| 打包范围 | 包根下的**所有文件**，排除 `node_modules/` 与 `.git/`；不解释 npm 的 `files` / `.npmignore`（DPK 做内容忠实打包，不做发布裁剪），且拒绝符号链接与特殊文件 |

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
  "generator": "dpk/1.0.0",
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
| `name` | string | ✅ | 必须等于 `package/package.json` 的 `name`；须匹配 npm 包名文法且带 `@local/` 作用域（见 §6.1） |
| `version` | string | ✅ | 必须等于 `package.json` 的 `version`；须为 semver |
| `createdAt` | string | ✅ | RFC 3339 / ISO 8601 UTC，用于溯源；**不参与**完整性计算。默认取可复现时刻 `1980-01-01T00:00:00.000Z`，`--created-at now` 才写真实构建时间（见 §5 可复现性） |
| `generator` | string | ✅ | `<tool>/<version>`，例如 `dpk/1.0.0` |
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
| `name` 缺少 `@local/` 作用域时**自动补全**（`PACKAGE_LOCAL_SCOPE` 提示写入 checkNotes）：DPK 是本地分发格式，所有 dpk 写出的层（归档清单、store 副本、账本）统一携带 `@local/`，本地包不得遮蔽 registry 上的公共名；源目录本身不被改动 | DPK 规范自身约定 |
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

---

## 8. 安装语义

### 8.1 流程

```
1. 读文件 → zip 结构校验（§5）
2. 读 dpk.json → 字段校验（§4）→ 与 package/package.json 交叉校验（§6）
3. 逐文件 sha256/size 比对 + integrity.digest 重算（§7）
4. 解包到 <home>/dpk/store/<digest>/package/  （先写临时目录，再原子改名）
5. 交给官方安装器：
       plugin_manager action=install_bundle target=<abs path>      （会话内）
       dsh plugin --profile <p> install <abs path>                 （命令行）
6. 官方安装器负责 pnpm 落地、写入 profile 依赖、把新 bundle 追加进 dsh.profile.bundles
7. 记录到 <home>/dpk/index.json（DPK 侧的溯源账本，DSH 不读它）
```

任一步失败即中止，且**不留下半装状态**：第 4 步之前失败不改动文件系统；第 4 步用"临时目录 + 改名"保证原子性；第 5 步失败时给出明确的回滚提示（删掉 store 目录即可，profile 未被动过）。

### 8.2 本地仓库布局

```
$DSH_HOME/dpk/
  index.json                       # 溯源账本：{ entries: [{name, version, digest, installedAt, source, path, profiles[]}] }
  store/<digest>/package/          # 解包后的包根（就是交给官方安装器的 target）
  store/<digest>/dpk.json          # 归档清单副本，便于事后审计
  archives/<name>-<version>.dpk    # 可选：归档留存（--keep-archive）
```

内容寻址（`store/<digest>/`）带来三件事：同一 DPK 重复安装天然幂等；不同版本/不同构建不会互相覆盖；`index.json` 损坏也不影响已装内容。

### 8.3 便捷性承诺

- `dpk install x.dpk` 默认读 `DSH_PROFILE`（无则 `default`），无需手写 profile 名；
- `--dry-run` 走完 §8.1 的 1–3 步并打印将要执行的官方命令，不写盘；
- `dpk verify x.dpk` 可在无 DSH 的机器上跑（纯 Node，无依赖）；
- 找不到 `dsh` 命令时，把**确切的官方命令**打成可直接复制的一行，并同时给出 `plugin_manager` 工具写法。

---

## 9. 版本演进

| 场景 | 行为 |
| --- | --- |
| `dpk` 小于等于实现支持 | 正常处理 |
| `dpk` 大于实现支持 | 拒绝，提示升级 dpk 工具 |
| 出现未知字段 | 拒绝（v1 规则） |
| 加字段 | 升 `dpk` 到 2，并在实现中同时支持 1 与 2 |

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
| 执行代码 | `verify`/`inspect` 不执行包内任何代码、不加载包内任何模块 |

---

## 11. 与相关机制的关系

| 机制 | 关系 |
| --- | --- |
| npm tarball（`.tgz`） | `.tgz` 本来就能被 `pnpm add` 直接吃下（`TARBALL_SPEC`），但它没有 DSH 侧的合规预检，也不固定内容布局。DPK 走 zip + 强校验，安装前即可判定"这是不是一个合法的 DSH 包" |
| `dsh plugin install <path>` | DPK 的解包产物就是它的合法入参 |
| `plugin_manager install_bundle` | 会话内等价入口；两者都由官方实现执行 pnpm 与 bundle 选择 |
| profile 的 `cordis.patch.yml` | DPK 不碰它；用户层的覆盖仍在 profile 里做 |
| HMR | 安装完成后由官方链路触发重载；DPK 不自行重启任何东西 |

---

## 12. 一致性测试清单（实现必须覆盖）

1. zip 往返：写 → 读 → 内容与 CRC 一致；`unzip -t` 独立复核通过。
2. 可复现：同目录两次 `pack` 产出逐字节相同。
3. 篡改：改 `package/` 内任一字节、增删一个文件、改 `dpk.json` 的 size/sha256/digest → `verify` 全部失败。
4. 路径攻击：`../x`、`/x`、`C:\x`、`a\\b`、大小写碰撞、重复路径 → 全部拒绝。
5. 归档攻击：加密位、zip64、未知压缩方法、超大压缩比 → 全部拒绝。
6. DSH 合规：非法包名、缺 `version`、`dsh.bundle.patch` 指向不存在文件、icon 越界/超 256 KiB、`dsh.client.platform` 缺失 → 全部失败；合法包全部通过。
7. 角色判定：bundle / client / plain 三种包的 `roles` 正确。
8. 安装：`--dry-run` 不写盘；真实安装后 `store/<digest>/package` 存在、`index.json` 记录正确、官方安装器收到的是绝对路径。
9. 幂等：同一 DPK 装两次不产生第二个 store 目录。

---

## 13. 受管数据卷（dpkg 语义）

一个包的**持久文件**通过 `package.json` 的 `dsh.data.volumes` 声明一次，dpk 据此（且仅据此）物化、升级与清除它们——安装全程不执行包内任何代码，插件在 dpk 给出的路径上读写自己的文件。

### 13.1 声明

```json
"dsh": {
  "data": {
    "volumes": [
      { "id": "providers",        "class": "config", "path": "providers.json", "seed": "seeds/providers.json" },
      { "id": "credentials",      "class": "state",  "path": "credentials.json" },
      { "id": "captcha-profile",  "class": "cache",  "path": "captcha-profile/cookies" }
    ]
  }
}
```

| 字段 | 约束 |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]*$`，包内唯一 |
| `class` | `config` / `state` / `cache` 三选一 |
| `path` | 卷内相对路径（可嵌套）；拒绝绝对路径、盘符、`..`、反斜杠；包内唯一 |
| `seed` | 可选；包内文件路径，安装期作为卷的初始内容物化 |

类语义（镜像 config/state/cache 的经典三分）：

| class | 含义 | 迁移 | 生命周期 |
| --- | --- | --- | --- |
| `config` | 用户手写的配置（dpkg 的 conffile） | ✅ `dpk` 导出/导入携带 | remove 保留，purge 删除 |
| `state` | 机器绑定的事实与凭证 | ❌ 永不迁移（换机重新登录/生成） | remove 保留，purge 删除 |
| `cache` | 可再生的派生数据 | ❌ | 随时可删 |

### 13.2 布局与所有权

```
<home>/data/<scope>/<name>/<class>/<path>     # 卷内容(插件读写)
<home>/data/<scope>/<name>/.dpk/<id>.seed.json  # dpk 私有:该卷来自哪个种子代
```

目录名由包名派生（带 scope 目录，`@local/pkg` → `data/@local/pkg`），包不写死路径。`.dpk/` 是管理器私有区，插件不得读写。

### 13.3 生命周期（逐条对齐 dpkg）

| 事件 | 行为 |
| --- | --- |
| 首次安装 | 带 `seed` 的卷把种子内容物化到卷路径并记录种子摘要；无 `seed` 的卷**什么都不写**——目录由插件首次写入时诞生 |
| 升级安装 | 卷已存在且与记录的种子摘要一致（或等于新种子）→ 原地刷新为新种子；与种子不一致（用户改过）→ **保留本地文件**，新种子写到旁边 `<name>.dpk-new`（dpkg 的 conffile 规则）；没有种子标记的既有文件 → 视为用户数据收编（`adopted`），绝不覆盖 |
| 重复安装同版本 | 同"升级"；用户改动永远存活 |
| remove（卸载包） | 卷全部保留 |
| purge（`dpk purge`） | 删除整个 `data/<scope>/<name>`（config、state、cache、标记一起） |
| 导出/导入 | 只携带 `config` 卷；导入落地为**用户数据**（不留种子标记，后续升级按"用户改过"对待，永不静默覆盖）；携带未声明为 config 的文件 → 拒绝 |

### 13.4 校验

- 声明在 `pack` 时严格校验（id/class/path 文法、唯一性、seed 存在且在包内、seed ≤ 1 MiB、卷数 ≤ 64），且**仅**随 `dpk.json` 的 `dsh` 逐字副本携带（2.1.8–2.1.9 曾另写一份顶层 `data` 副本，因白名单读取端整包拒收，已于 2.1.10 移除；顶层 `data` 现为未知字段，读到即拒）；
- `verify` 对 `dsh.data` 副本再跑同一套校验，且与 `package/` 内声明交叉比对，不一致即拒绝；
- `install` 在**官方安装器成功之后**物化卷（dpkg 也是先解包再放 conffile），失败即中止且不留半装状态。
