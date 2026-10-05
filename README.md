# DSH 安装包管理助手（dpk）

`dsh-dpk-manager` —— 把**一个标准 DSH 包目录**打包成单个 `.dpk` 文件（本质是 zip），
并在本地可靠地安装它。它是一个**标准 DSH 插件**（`dsh.bundle.patch` + 中文标题的插件卡片 +
图标），按 DSH 桌面版插件的规范安装与更新，**不向系统注入任何命令**：

| 形态 | 入口 | 用法 |
| --- | --- | --- |
| 插件页面板 | `client.js` → 「本地 DPK」侧栏 | 导入 `.dpk`、导出插件（仅 app）/ 迁移插件（app+data）、卸载，人点按钮即可 |
| 官方插件页徽章 | `client.js` → `plugins.detail.badge` | 由本管理器装好的包，在官方插件页标题旁显示「该插件由 dpk 管理器安装和管理」 |
| 会话内工具 | `index.js` → 注册 `dpk` 工具 | 装进 profile 后，agent 可直接 `dpk action=verify/install/…` |

```text
dpk update                 检查已装的包有没有新版本。npm 包（官方插件页装的，profile 里是 ^range 行）经官方管理器问 registry；.dpk 文件包看来源目录。有新版就提醒，`upgrade` 逐个装
dpk upgrade                把那些更新装上
dpk install <文件.dpk>     验真 → 解到本地仓库 → 把 profile 写成 DSH 读得懂的样子（不跑 pnpm）
dpk remove name=<包>       从 profile 卸下（包名写 @local/x 或 x 都认），并回收无人引用的 store 副本；
                           该 profile 本来没装它时报错并列出它实际装了什么，不谎报成功
dpk purge name=<包>        删除该包的全部受管数据卷
dpk autoremove             回收所有无人引用的 store 副本，以及被中断写入留下的暂存物
dpk list                   列出 dpk 装过什么、谁在用、能不能被 loader 解析（含 profile 引用但账本没记的）
dpk show <文件.dpk|包名>   一个动词回答"这是什么"：清单，或版本/digest/store 路径/谁在用/数据卷
dpk verify <文件.dpk>      结构 + 完整性 + DSH 合规（装之前先用）
dpk build <目录>           校验 DSH 合规 → 写出 .dpk（同输入逐字节可复现）
dpk export name=<包>       导出该包的 **app 卷** → 单包 JSON；不带 data 卷
dpk export all             全部 dpk 安装插件的 **app 卷** → `.dpks` 归档
dpk snap name=<包>         **快照**该包的 **app + data 卷** → 单包 JSON
dpk snap all               **整机快照**：全部插件的 **app + data 卷** → `.dpks` 归档
                           （归档 zip：`dpks.json` 清单只列路径，内容各在 `data/<包>/<卷路径>` 条目里一次）
                           默认名按动词分：`<包>-data.json` / `<包>-snap.json`、`dpks.dpks` / `snap.dpks`
dpk import <文件>          写回数据卷。按**内容**认两种文件：单包 JSON 与 `.dpks` 归档——改名也认、
                           也不问它出自 export 还是 snap；落位按包**当前声明**的类，未装的包跳过并提示
dpk pkg op=list            读一个数据文件里带了哪些包、每个包哪些卷（只读）
dpk pkg op=add name=<包>   把一个**已装**包并入该文件（已存在就刷新那条条目；默认 app+data，
                           `verb=export` 则仅 app）
dpk pkg op=remove name=<包>  从该文件里删掉一个包的条目
dpk pkg op=set name=<包> to=<新名>
                           **改包名**：把文件里那条记录改成新名字，卷的字节一动不动（归档里
                           承载卷的 `data/<包>/…` 条目随之改名）；新名本机没装也可以
                           —— 形态随内容：1 个包 = 单包 JSON，≥2 个包 = `.dpks` 归档；
                           增到第二个包升为 `.dpks`，删回一个降回 `.json`，旧名一并移除
```

六个会改写 profile、持久数据或本地仓库的动作（`install` / `upgrade` / `remove` / `purge` /
`import` / `autoremove`）都需要 danger-full-access 提权或批准；只读动作（`update` / `list` /
`show` / `verify` / `build` / `export` / `snap` / `pkg`）不需要——`pkg` 只动你指定的那个文件。

### 导出/导入：两个动词 × 两个作用域

**动词决定带哪些类**，**作用域决定装几个包**——两条轴正交，四种组合各自只是一次选择：

| | 一个包（`name=<包>`） | 全部包（`all: true`） |
| --- | --- | --- |
| **`export`**（仅 app） | 单包 JSON，`dpk-config-data/1` | `.dpks` 归档，`dpks-data/1` |
| **`snap`**（app + data） | 单包 JSON，`dpk-config-data/1` | `.dpks` 归档，`dpks-data/1` |

容器不区分动词：`import` 认两种文件、也不问它出自哪个动词，区分只在携带的类。默认文件名相同，同名导入不会
混淆，因为单包 JSON 里写着 `package`、归档里写着清单。

**形态由内容决定。** 一个包 = 单包 JSON，两个及以上 = `.dpks` 归档；`dpk pkg` 增删包时文件就在这两个形态
之间迁移，扩展名跟着改（`.json` ↔ `.dpks`），旧名随即删除。所以读取端从不只信文件名或清单里的 `format`：
一份手写的、写着单包却列了多个包条目的文件照样能读（条目自带 `package` 时以条目为准，见
[data-file.mjs](lib/data-file.mjs)）——拒绝一份完全可读的数据没有道理。

一个 `data` 卷和一个 `app` 卷**共用同一条相对路径**是合法的（两类目录各自成根），所以条目一律带 `<class>/`
前缀：导入先按"类 + 路径"精确匹配，认不出时才按路径匹配（覆盖包在两个版本之间把某个卷换了类的情况）。

### 命令样式：对标 apt

dpk 是本地文件安装器，命令形状照抄 **apt**——高层动词、一个动词一件事——而不是 `dpkg`
（低层工具、一堆 `-i/-r/-P/-l` 开关，还要分清 `dpkg` 与 `dpkg-deb`）。上一版曾按 dpkg 命名
（`info`/`build`/`which`/`data`），现已调回 apt 的说法，并把 `which`/`data` 并进 `show`。

| dpk | apt | 说明 |
| --- | --- | --- |
| `update` | `apt update` | 上游按包分两类：`.dpk` 文件包看来源目录；**npm 包问 registry**（经官方管理器的 `inspect` = profile 内的 `pnpm view`，registry/代理/认证全部沿用官方插件页的配置）。不缓存、不落状态，只报告 |
| `upgrade` | `apt upgrade` | 把已装的包升到可用最新版。**npm 包逐个经官方 `installBundle(name@version)` 走 pnpm**（registry 树只有 pnpm 装得了），`.dpk` 包由 dpk 自己装；每个引用了旧版的 profile 各装一次，并顺手回收被替换的 store 副本 |
| `install <文件>` | `apt install ./x.deb` | 同一形状：装一个本地文件 |
| `remove` / `purge` | `apt remove` / `apt purge` | 卸下 / 连受管数据一起删 |
| `autoremove` | `apt autoremove` | 删掉不再被任何 profile 引用的东西 |
| `list` | `apt list --installed` | 已装清单（含 `broken` 诊断，见下） |
| `show <文件\|包名>` | `apt show <pkg>` / `apt show ./x.deb` | 一个动词回答"这是什么"；dpk 顺带列出 store 路径、引用它的 profile、受管数据卷 |
| `verify` / `build` | apt 无对应 | apt 在下载时验哈希、也不打包；dpk 的对象是**一个存档** |
| `export all` → `.dpks` | `apt` 无直接对应（形如把 `/var/lib` 整体打包） | **多包归档**：全部已装插件的 app 卷；`snap all` 是同时带 data 卷的那种 |
| `reinstall: true` | `--reinstall` | 同一个 digest 也重新落一次 store 副本 |
| `deep: false` | `--no-debsig` 的性质 | 跳过"再解一次并当 DSH 包校验"这一步 |
| `directory=` | 无对应 | dpk 没有 `sources.list`：`.dpk` 包的 `update`/`upgrade` 默认看这些包**上次从哪来**（账本记着 source），需要时用这个参数再补一个目录；npm 包的来源就是 registry，不需要配置 |
| `via: "profile" \| "service"` | 无对应 | dpk 自有选择：谁去写 profile（自己写，还是交给官方管理器跑 pnpm） |

dpk **不借** apt 的仓库面：没有远端索引、`sources.list`、优先级/pinning，也没有 `full-upgrade`
（dpk 没有依赖图，它与 `upgrade` 无从区分）。理由同一条：dpk 装的是本机文件。

也**不留归档副本**：`.dpk` 本来就在你手上，store 副本随时能 `export` 回一个 `.dpk`，
所以在 dpk 目录里再存一份只是重复（`keepArchive` 与 `apt clean` 的对应物因此都不存在）。

改用 apt 名字的对应关系：`inspect`→`show`、`which`/`data`→`show`、`pack`→`build`、
`uninstall`→`remove`、`gc`→`autoremove`、`force`→`reinstall`。旧名不再接受，避免两套词汇并存。

设计文档见 [SPEC.md](SPEC.md)（格式规范 v1，逐条可判定）；JSON Schema 见
[schemas/dpk-1.schema.json](schemas/dpk-1.schema.json)（由 `test/schema.test.mjs` 钉住与校验器一致）。

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
  面板与工具都默认由 dpk **自己把 profile 写好**：依赖行、`dsh.profile.bundles`、
  `node_modules` 链接、`pnpm-lock.yaml` 的 importer 行 —— 这四处正是 Harness loader
  读取的全部内容。**不跑 pnpm、不依赖官方管理器**，所以它在一个 bundle 正在运行时也能装
  （官方管理器此时会以 `not-removable` 拒绝）。重启 Harness 后新包生效。
- **覆盖安装**：导入新版本直接换行、换链接（同一个 store 目录就报 `unchanged`，见下面的耗时表）；
  导入同一个 digest 时，dpk 先读 profile 确认四处都已指向该目录，成立即不做任何写入。
- **卸载**：`dpk remove name=…`（面板上的卸载同理）删掉那四处并清理账本与无人引用的 store 副本；
  同样不跑 pnpm —— 官方 `removeBundle` 对任何已启动的 bundle 都会答 `not-removable`。
- **需要官方机制时**：`via: "service"` 会把安装交回官方安装器（它跑 pnpm、能处理 registry
  依赖与原生编译），代价就是那一次 pnpm 启动。默认路径也会在**包自己声明了 runtime
  `dependencies`** 时自动走 `service`：链接一个 store 目录只能给出包本身，给不出它期望的 registry
  依赖树，那是 pnpm 唯一不可替代的地方。SPEC 要求的自包含包（含本仓库的两个）都不声明 runtime
  依赖，所以它们走的是零 pnpm 的那条路。
- **打包**（对任意标准 DSH 包目录）：`dpk build directory=<包目录>` —— 归档默认落在**该包目录下的
  `dpk-dist/<name>-<version>.dpk`**（目录自动创建，与源在同一棵树里，不用管当前目录在哪）。
  需要别的落点就写 `output=<文件路径>`；`output` 也可以写成**目录**（已存在的目录，或以分隔符结尾的路径），
  此时同样按 `<name>-<version>.dpk` 命名写进去，目录同样会被自动创建。
  归档留在包目录里就用 `dpk-dist/` 或 `dist/` —— 这四个目录（连同 `node_modules/`、`.git/`）
  永不入包，所以刚生成的 `.dpk` 不会被当成包内容，也不会让下一次打包撞上"包内不允许归档"。
  也可以编程调用 `dsh-dpk-manager/lib/pack.mjs` 的 `packDirectory()`（库随包发布，`exports` 已导出）。
- **验真**：`dpk` 工具 `action=verify file=…`，不需要执行包内任何代码。

`install` 的输出会明确告诉你三件事：解到哪、谁写的、账本记在哪：

```
package  @local/dpk-hello@1.0.0 (bundle)
store    C:\Users\…\.dsh\dpk\store\<digest>\package
profile  dpk-demo (written by dpk; live at the next Harness start)
```

## 会话内工具 `dpk`

十四个动作（见上表）：`update` / `upgrade`（有更新可用吗 / 装上）、`show`（看清单或看已装的包）、`verify`（结构+完整性+DSH 合规）、`build`（打进 `.dpk`）、
`install`（装进当前 profile）、`remove`（从当前 profile 卸下）、`list`、`autoremove`
（回收无人引用的 store 副本）、`export` / `snap` / `import` / `pkg`（数据卷的搬运：导出、快照、写回、增删改查）、`purge`（删除一个包的全部受管数据卷）。

- `install`、`upgrade`、`remove`、`import`、`purge` 与 `autoremove` 是会改写 profile、持久数据或本地仓库的动作，
  都**先过沙箱提权判定**（`danger-full-access`，与官方 `plugin_manager` 相同的请求与理由文本）；
  判定器不可用时**一律拒绝执行**。判定发生在 dpk 写任何东西之前，所以它没有因为不再调用官方服务而变松。
- `list` 顺手做**可加载性诊断**：它像 `dpkg --audit` 一样回答"现在装的东西还能不能起来"。
  对每个仍被 profile 引用的包，它按 loader 读的三处（依赖行 / `dsh.profile.bundles` / `node_modules`
  链接）核对一遍，有分歧就打成 `broken` 并给出修复动作（重装它的 `.dpk`，或 `dpk remove` 掉这一行）。
  这些事实全部可从 profile + store 推导，所以不新增状态文件、不新增命令。
  被 profile 引用、账本却从没记过的包（写入被中断留下的那种状态）也会列出来并标 `untracked`：
  清点读的是 profile 这份权威，不是 dpk 自己的账；账本只是来源记录，缺了它不该让一个真在跑的包从清单里消失。

首次安装或更新 `dsh-dpk-manager` 后，Host/工具代码要等 Harness 重启才会进入新的模块代次。
面板的「需要重启」提示不再是标记文件：它由**账本里的安装时间与本进程的启动时间**比较得出
（账本里有比本次进程启动更新的安装 = 还没加载），因此既是只读判断，也永远不会过期。

## dpk 会写哪些路径

`<home>` = `DSH_HOME`（默认 `~/.dsh`）。这是全部写入面，没有别的目录：

| 路径 | 内容 | 何时 |
| --- | --- | --- |
| `<home>/dpk/store/<digest>/package/` | 解包后的包本体（profile `link:` 的目标），**只有 digest 目录** | install |
| `<home>/dpk/cache/` | 唯一的事务暂存区：store 落位、reinstall 让位、账本、profile 清单的暂存物都在这里；写入者改名成功后若它已空就删掉它 | 每次写入期间；中断留下的由 `autoremove` 回收 |
| `<home>/dpk/index.json` | 溯源账本：`name/version/digest/installedAt/source` | install / upgrade / remove / autoremove |
| `<home>/profiles/<p>/package.json` | 依赖行 `link:<store 目录>` + `dsh.profile.bundles` | install / upgrade / remove |
| `<home>/profiles/<p>/node_modules/<name>` | 指向 store 目录的链接（引用判定的权威来源之一） | install / upgrade / remove |
| `<home>/profiles/<p>/pnpm-lock.yaml` | `.` importer 的那一行 | install / upgrade / remove |
| `<home>/profiles/<p>/pnpm-workspace.yaml` | `minimumReleaseAge: 0` | 仅 `via: "service"` |
| `<home>/data/<scope>/<name>/{data,app}/…`、`.dpk/*.seed.json` | 受管数据卷（`data` 由声明/种子管，`app` 随 `export` 走）与种子标记；旧类名（`config`/`state`/`cache`）声明报错，旧类名目录不读也不搬迁 | install / upgrade / import / purge |
| 系统临时目录 `dpk-verify-*`、`dpk-incoming-*`、`dpk-outgoing-*` | 独立验真的解压目录、面板上传的中转、面板下载文件的暂存 | 用完即删 |

暂存物（写一半的目录/文件）由写入方在失败时立即删除；进程被杀而留下的，由 `dpk autoremove` 按"名字里的
pid 已不存在"回收——**活着的那次写入绝不动**。`store/` 里若还有旧世代在自己目标旁边留下的暂存残留
（dpk ≤ 2.1.43 的写法），那是**见到即删**：那些世代不在服务范围内。

dpk 只管理自己的路径：dpk 目录或 profile 里出现别人的文件，它既不删也不报错（`autoremove` 只认暂存命名约定）。

**不向后兼容**：旧世代的归档、布局与残留一律拒绝或直接删除，不做静默迁移（详见 SPEC §9）。

不写：DSH 应用安装目录、`<home>/storages`、settings、会话数据、别的插件的 `node_modules`；
不做全局安装、不写 PATH、不写注册表。`via: "service"` 时 `node_modules/.pnpm`、`.modules.yaml`
这些是 pnpm 写的，不算 dpk 的写入面（那也正是默认路径不跑 pnpm 的原因之一）。

**store 只保留 profile 真正引用的 digest**：判据永远是 profile 的依赖行，不是账本。
`remove` 与 `upgrade` 各自只回收**自己替换掉的那一个** digest（只读得到全部 profile 时才动手，读不到就保留并说明）；
把 store 收敛到"只剩被引用的"是 `dpk autoremove` 的事——它的整个语义就是回收，所以只有它会做全量清扫。

## 与 apt/dpkg 的对照

dpk 是这条链里 **dpkg 那一半**（装一个本地文件、记清楚自己做过什么），不是 apt 那一半（仓库、解析依赖）。
用 apt 的清单逐条对过，结论是：能借的都已经是现在的形状，剩下的借过来只会变成仪式。

| apt/dpkg | dpk 对应 | 状态 |
| --- | --- | --- |
| `control` 与 `data.tar` 分离 | `dpk.json` 与 `package/` | 已有 |
| `apt show ./x.deb` / `dpkg-deb -I`（装前看清单） | `dpk show <文件>`（读清单，不解包）/ `dpk verify`（深校验） | 已有 |
| `md5sums` 与 `Release` 完整性 | `files[].sha256` + `integrity.digest` | 已有 |
| `dpkg -i` 先解到临时处再原子就位 | `store/<digest>.tmp-*` → 改名 | 已有 |
| conffile 三方合并（`.dpkg-dist`） | `.dpk/*.seed.json` + `.dpk-new`，用户改过的不覆盖 | 已有 |
| `dpkg --purge` 与 `-r` | `dpk purge` 与 `dpk remove` | 已有 |
| `apt-get autoremove` | `dpk autoremove`（store 副本、孤儿目录、遗留文件） | 已有 |
| `dpkg --audit`（装的东西还能不能起来） | `dpk list` 的 `broken` 诊断 | 已有 |
| `Depends` 解析 | 声明了 runtime `dependencies` 就交给 pnpm（`via: "service"`） | 已有（边界明确：dpk 不做解析） |
| `/var/lib/dpkg/status` 状态库 | 不带 | **刻意不借**：dpkg 需要它是因为一次装几千个文件、要跑维护者脚本；dpk 每次只创建三处、全部由名字与 digest 推出，重跑即幂等收敛。再存一份"装到哪一步"就是第二份真相 |
| `info/<pkg>.list` 文件清单 | 不带 | **刻意不借**：同上，写入面可推导 |
| 两阶段 unpack / configure | 单阶段 | **刻意不借**：dpk 不执行包内任何代码，没有 configure 阶段；半装状态由"链接先于依赖行"的写入顺序变得无害 |
| `dpkg --verify` / debsums 全量校验 | 不带 | **刻意不借**：安装时已验过一次归档；store 副本会被 dpk 改名（作用域），且没有任何东西会消费"跑起来之后又变了"这个答案 |
| `Conflicts` / `Breaks` | 不带 | **刻意不借**：行级冲突归 DSH loader；dpk 不实现 YAML 语义，靠正则猜行 id 只会制造假警报 |
| `apt update` 的索引 | 不缓存:dpk 的源是本机目录,扫一遍是毫秒级 | 已有(`update` 只报告) |
| `apt-mark hold` / pinning | 不带 | **刻意不借**：`autoremove` 之后重装一个 `.dpk` 约 0.3 秒，为"留住旧版本"加一份状态不值 |
| 仓库索引 / `sources.list` / 优先级 | 不带 | 不需要：dpk 装的是本地文件，没有要解析的远端 |

## 受管数据卷（dpkg 语义，SPEC §13）

包可以用 `package.json` 的 `dsh.data.volumes` 声明自己的持久文件，dpk 负责它们的整个生命周期
（声明校验、首装种子、conffile 式升级、remove 保留 / purge 清除、数据卷导出导入）。布局：

```
<home>/data/<scope>/<name>/{data,app}/…      卷内容(插件读写)
<home>/data/<scope>/<name>/.dpk/*.seed.json          dpk 私有种子标记
```

- **升级规则**：用户没改过的种子卷原地刷新；改过的新种子落到旁边 `.dpk-new`，本地文件永不
  被静默覆盖；无种子标记的既有文件按用户数据收编。实测：重装同一 DPK，改过的
  `providers=kept-local`、没改的 `prompt-overrides=refreshed`。
- **卷分类是 `data`/`app` 两个名字，差别只在迁移**（旧类名 `config`/`state`/`cache` 声明直接报错，
  其目录不读也不搬迁）：`data` 是包声明的设置（换机由声明重建，不随 `export` 走），
  `app` 是包运行期自己写下的东西（会话、凭证、派生数据，`export` 携带）。换机迁移 = 装好包 +
  导入 `.dpks`，新机接着现在跑。
- 安装期不执行包内任何代码（与 verify 同一红线）；卷先校验、再写入，且都在 profile 指向该包**之前**完成，
  所以卷装不上时 profile 一个字不改，上一版继续可用。
- 本插件**不 import 任何 Harness 包**：`tools`、`sandboxPolicy`、`approval`、`pluginManager`
  全部经 `ctx` 服务拿；工具定义按 Harness 自己的参数 schema 形式手写，提权判定按
  `@deepseek-ai/dsh-sandbox#approveEscalation` 的规则与措辞镜像实现。这样一个 profile bundle
  在宿主自己的模块加载器下不会因为裸导入解析不到而失效，也让本包能作为 `.dpk` 自包含地分发。

## 为什么这样设计：它严格贴着 DSH 的标准

| DSH 的既有事实 | 出处 | DPK 的对应设计 |
| --- | --- | --- |
| 安装 spec 只认 `registry` / `path` / `git` / **`tarball`（仅 `.tgz`、`.tar.gz`）**；zip 会被判 `invalid-spec` | `packages/boot/plugin-manager/src/install-spec.ts:29,68-90` | `.dpk` 不冒充 spec：验真后**解包成目录**，让 profile 的依赖行指向它（`via: "service"` 时把绝对路径交给官方安装器，`kind: 'path'`） |
| 本地路径 spec 必须是绝对路径 | 同上 `:72-76` | store 用绝对路径寻址（`$DSH_HOME/dpk/store/<digest>/package`） |
| loader 只读三处：`dependencies` 行、`dsh.profile.bundles`、以及从 profile 出发的 Node 解析（`node_modules/<name>`） | `packages/boot/app-boot/src/profile.ts:630-641`、`:655-692` | 默认安装就写这三处（外加 pnpm 会写的那条 `pnpm-lock.yaml` importer 行），不跑 pnpm、不依赖官方管理器 |
| 官方 `installBundle` 会跑 pnpm（联网解析 registry 依赖、每次启动进程） | `operations.ts:284-460`、`:118,160` | `via: "service"` 保留这条路；默认路径既然只是写那四处，就没有让 pnpm 介入的理由 |
| 官方 `removeBundle` 对任何**已启动**的 bundle 答 `not-removable`（`startedBundles` → `management-required`） | `packages/boot/plugin-manager/src/index.ts:188-210,291-293,605` | `uninstall` 自己删那四处；bundle 的行在下次启动时不再加载 |
| pnpm 的供应链冷却期（`minimumReleaseAge`）只在 pnpm 跑起来时才有意义 | pnpm 11 `minimumReleaseAge`/`minimumReleaseAgeStrict` | 默认路径不跑 pnpm，因此不需要豁免；`via: "service"` 时导入前仍把 profile 的 `pnpm-workspace.yaml` 写上 `minimumReleaseAge: 0`（用户显式配置过的值永不改写） |
| bundle = `package.json` 里声明 `dsh.bundle.patch` | `packages/util/package-manifest/src/types.ts:69-72` | `pack` 校验补丁存在、在包内、是 `.yml/.yaml`，并把它复制进 `dpk.json`；安装时也用它决定要不要写进 `dsh.profile.bundles`（与官方 `reconcile` 同一判据） |
| 展示元数据读 `locale/<lang>.json` 的 `meta.title/description`；图标必须相对路径、允许的扩展名、realpath 在包内、≤256 KiB | `packages/boot/app-boot/src/package-meta.ts:10,15-19,24-39,101-122` | `pack`/`verify` 逐条镜像这些规则，不满足直接拒绝 |
| 包名文法与长度上限 | `install-spec.ts:31-32` | `dpk.json.name` 与 `package.json.name` 必须一致且通过同一文法 |
| DSH 读元数据时**不加载插件代码** | `package-meta.ts` 模块注释 | `verify`/`show` 同样不执行包内任何代码 |

一句话：**DPK 只负责运输、验真，以及把 profile 写成 DSH 读得懂的样子。**安装完成后 profile 里躺着的是一条普通的
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
  index.json                    dpk 的溯源账本（DSH 不读它；谁在用读 profile）
  store/<digest>/package/       profile 的 link: 目标（只保留被引用的 digest）
```

内容寻址（目录名 = `integrity.digest`）带来的性质：同一 DPK 重复安装天然幂等；不同构建不会互相覆盖；
`index.json` 损坏也不影响已解包内容。

## 安装耗时（本机实测，Windows）

安装在 Windows 上的成本几乎都在**文件创建**上，所以默认路径只做三件事：解压一次、写一次 store、
写四处 profile 记录。**不启动 pnpm**，也不经过官方管理器：

| 场景 | 本地耗时 | pnpm |
|---|---|---|
| 冷安装（首次/新 digest） | ~0.35 s（506 KB / 104 文件） | **不跑** |
| 温安装（同 digest 重复导入） | ~0.03 s | **不跑** |
| 对照：`dpk verify`（深校验） | ~0.35 s | — |
| 对照：`via: "service"` | 同上 + 官方管理器开销 | 跑 1 次（~0.5–1.1 s） |

三处优化：

1. **单次解压校验**：`verifyArchive(buffer, { extractTo })` 在**一次解压**里同时校验每个条目的
   size+sha256 并把它写进 store 的暂存目录，随后就地对这棵树做 DSH 一致性校验。此前是"解压到临时
   目录校验 → 丢掉 → 再解压进 store"，同一批文件写两遍。
2. **同 digest 复用**：digest 已在 store 里时，只需重新哈希归档（内容寻址已保证内容同一），
   深校验由当初落库时那次负责。
3. **不跑 pnpm**：`lib/profile-install.mjs` 直接写 Harness loader 读的那四处。`installedState()`
   先确认四处都已指向同一个目录，成立就一个字节都不写；否则写依赖行、`node_modules` 链接与
   lockfile 行。官方服务保留为 `via: "service"`。

pnpm 那条路真正的问题不是慢，而是**在运行时不可用**：官方 `removeBundle` 对任何已启动的 bundle
答 `not-removable`（`startedBundles` → `management-required`），于是"覆盖安装/卸载一个正在跑的
插件"在官方路径上只能靠重启绕过；自洽写入没有这个限制，改完下次启动生效。

基准脚本：`node scripts/bench-install.mjs [dpk 路径] --runs 3`（用临时 DSH home，不碰真实 store/profile）。

## 安全模型

- **完整性有，真实性没有**：DPK 能证明"内容自打包后未被改动"，不能证明"是谁打的包"。
  v1 没有签名（`dpk.json` 顶层出现 `signatures` 会被拒绝，字段名留给 v2）。
- 解包前逐路径校验 + 解包后 `realpath` 复核，双重防 zip slip。
- 四重炸弹护栏（条目数/单文件/总量/压缩比）。
- `verify` 不执行包内代码、不加载任何模块。

## 已知边界（都是刻意的，写清楚比藏着好）

1. **归档永不嵌套**：包内出现任何 `.dpk` 文件都会被拒绝打包（`PACKAGE_NESTED_ARCHIVE`）——构建产物
   必须放在 `dist/`、`dpk-dist/`（这两个目录永不入包）或包外。历史归档里的嵌套杂物在导入时被自动剥离，store 只落一个干净包。
2. **本地分发的包在安装期归入 `@local/` 作用域**（如 `@local/example-provider`、`@local/dsh-reverse-skill`）。
   归档携带包的**本名**，`@local/` 由 dpk 在安装动作里补到 store 副本、patch 行名、账本与数据卷根上；
   源目录与归档清单都不写入作用域。loader 行 id 与模块自身的注册 id 不在自动改写之列——带 client
   半区的包请让这些 id 直接使用 scoped 名（`@local/example-provider` 是完整范例）。
3. **一个 DPK 只装一个包。** 套件请打成多个 DPK。多包归档（`packages/<name>`）留给 v2。
4. **带本地 `link:` 依赖的包不能单独分发。** 归档只携带一个包，其 `dependencies` 里
   `link:../sibling` 这样的相对目标在目标机器上不存在。要分发这类包，二选一：
   把它做成自包含（把共享代码并进包内，参见 [examples/hello-bundle](examples/hello-bundle)），
   或者把被依赖的包也各自打成 DPK 并按顺序安装。
5. **补丁文件只做结构校验**：DPK 不实现 YAML 解析器，只证明 `cordis.patch.yml` 看起来是顶层数组；
   完整语义由 DSH 在挂载时校验（`verify` 输出里标为 `note`）。
6. **可执行位不承诺保留**：包内文件以 `0644` 写入 zip，Windows 源码树本来也没有 POSIX 权限。
7. **Node ESM 模块缓存的既有约束**：安装/替换包后要让**新的 JS 代次**生效，仍需重启 harness——
   这是 DSH 侧行为（见 harness 文档），DPK 不绕过。
8. **归档与读取器必须版本对齐**：`dpk.json` 的 `generator` 记录写出归档的实现版本。同一个 `dpk: 1`
   之下语义改过不止一次（数据卷声明的落点、`@local` 的写入时机），而读取端对未知字段一律拒绝，
   于是"在别的机器上导入失败"多数是两端版本不同，而不是包坏了。报错末行会写明
   `archive written by …; this reader is …`：两侧不同就先对齐工具版本，再怀疑包本身。
   打包器与校验器现在跑同一套交叉校验，所以本机 `pack` 成功即意味着导入方过校验（前提是导入方
   也已是同一代实现）。

## 目录

```
dpk/
  index.js                     DSH 插件入口：注册会话内 `dpk` 工具（零 harness 导入）
  client.js                    「本地 DPK」侧栏面板（导入 / 导出 / 迁移 / 卸载）
  host-service.js              面板后端：Typert Remote 服务（dpk.* 五个方法）
  cordis.patch.yml             bundle 层：插入 Loader 行 dsh-dpk-manager
  locale/{en,zh}.json          插件卡片文案（zh 标题即「DSH 安装包管理助手」）
  icon.svg                     插件卡片图标
  SPEC.md                      格式规范 v1（设计正本）
  README.md                    本文件
  lib/zip.mjs                  纯 Node zip 读写（store+deflate、CRC32、路径与限额校验）
  lib/dsh-package.mjs          DSH 包严格合规（逐条镜像 DSH 规则，带出处）
  lib/dpk-manifest.mjs         dpk.json 构造/校验 + 声明交叉校验 + 完整性摘要
  lib/pack.mjs                 pack
  lib/verify.mjs               verify（含深度合规复检；extractTo 时校验与解压合成一次）
  lib/store.mjs                内容寻址仓库 + 账本
  lib/install.mjs              安装编排：解包（单次解压校验）+ profile 写入/官方服务交接 + 记账
  lib/profile-install.mjs      自洽 profile 写入：依赖行、dsh.profile.bundles、node_modules 链接、lockfile importer 行
  lib/profile-policy.mjs       profile 的 pnpm-workspace.yaml 冷却期豁免写入（仅 via: "service" 需要）
  lib/actions.mjs              动作层：工具与面板共用
  schemas/dpk-1.schema.json    dpk.json 的 JSON Schema
  examples/hello-bundle/       自包含示例包（发布时用 `dpk build` 打包成 dist/dpk-hello-1.0.0.dpk）
  test/                        测试（一致性清单 + 动作层 + 自洽写入 + autoremove + cache 生命周期 + schema 对齐）
```

## 测试

```powershell
npm test
```

覆盖 zip 往返/可复现/CRC 篡改/路径攻击/加密/zip64/未知方法/炸弹护栏、DSH 合规的每一类拒绝、
清单严格性与摘要重算、安装的幂等、失败不留账本、
`--force` 重建、`--keep-archive` 留存，以及 pnpm 冷却期豁免的写入/保留/幂等。
自洽写入一侧另有专门一组：依赖行/`dsh.profile.bundles`/`node_modules` 链接/lockfile importer 行四处是否落对、
重复安装是否零写入、非 bundle 依赖不进 bundles 列表、链接指向别处时是否判否、以及拒绝替换一个真实目录。
数据卷一侧另有两条不变式：同一份声明的不同书写形式（键序、卷的列表顺序、路径尾斜杠）必须同判，
且打包器的产出必然通过校验器的交叉校验。
