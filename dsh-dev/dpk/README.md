# dsh-dev/dpk — 本地 DPK 工作区

| 目录 | 内容 | 分发物 |
| --- | --- | --- |
| `dpk-manager/` | DSH 安装包管理助手（npm 包 `dsh-dpk-manager`） | `dist/dsh-dpk-manager-<version>.dpk` |
| `zcode-provider-dpk/` | `@local/zcode-provider` | `dist/zcode-provider-<version>.dpk` |
| `reverse-skill/` | `@local/dsh-reverse-skill` | `dist/dsh-reverse-skill-<version>.dpk` |
| `dpk-history/` | 历史归档（含嵌套事故时期的大文件，仅存证） | 不参与打包 |
| `scripts/pack-all.mjs` | **唯一打包入口** | — |

## 打包

```powershell
node scripts/pack-all.mjs
```

每个包：先跑它自己的 npm build（若有），再跑它自己的测试套件，全绿之后才从**源码树**
打包到自己的 `dist/`。任一环节不过即中止，且**一个产物都不写**：

1. **测试全绿**——包自己的套件必须全过（每个测试文件都跑，不因前一个失败而跳过后面的）；
2. **零嵌套归档**——归档清单里任何位置都不得出现 `.dpk`；
3. **零构建杂项**——`dist/`、`node_modules/`、`.git/` 不会入包；
4. **逐字节可复现**——同一目录连打两次必须完全一致。

测试排第一，因为"装上了但不工作"是唯一会直接落到用户身上的失败：zcode-provider 2.6.9
曾在 `tests/native-account.mjs` 失败的情况下出货（当时这里只跑 build），而那个包 `test`
脚本的 `&&` 串联又把 `tests/standalone-package.mjs`（证明归档在**没有 ZCode 的机器上**
也能激活并发请求的离线闸门）一起挡掉了。

## 不再出现嵌套归档——三层保障

- **打包器硬规则**：包内（`dist/` 等永不打包目录之外）出现任何 `.dpk`，打包与校验直接拒绝
  （`PACKAGE_NESTED_ARCHIVE`）——嵌套归档从"没人发现"变成"打不出来"；
- **构建产物归位**：产物只写 `dist/`（永不入包）；示例/演示归档不进源码树；
- **导入端剥离**：历史归档（如 2.5.35–2.5.38 嵌套时期产物）导入时，`dist/node_modules/.git`
  会被就地剥离，store 永远只落一个干净包。

事故复盘（2026-09-30）：历次归档被集中进 `zcode-provider-dpk/dist/`，旧打包器只排除
`node_modules/.git`，于是 2.5.35 起每版把此前全部归档卷进新包、体积逐版翻倍（10.9→21.8→43.6→87.3MB），
至多再一步就会撞上单文件 64MiB 上限。详见该目录内 `dpk-history/` 存证。
