# re-zcode — ZCode 研究/复刻统一工作区

> 2026-09-29 重组:工作区内 ZCode 逆向/复刻相关目录统一收纳于此。
> 根目录仅剩 `opencode/` 参考仓库、`.debug/` 草稿区与工作区级文档;
> DSH 宿主与启动器在 `../dsh-dev/`(`deepseek-harness/`、`launcher/`),
> **主线插件工程在 `../dsh-dev/dpk/zcode-provider-dpk/`(包名 `zcode-provider`)**。

## 目录索引

| 目录 | 性质 | 说明 |
|---|---|---|
| `re-app-server/` | 逆向(白盒化✅) | 官方 `zcode.cjs app-server` NDJSON 协议逆向:宿主剧本、注册表闸门、探针 |
| `zcode-analysis/` | 逆向证据库 | 权益差异分析报告(15 轮对齐)、桌面/CLI 线格式深挖、~70 个复核脚本 |
| `artifacts/` | 官方产物① | 安装包原件 `ZCode-3.14.1-win-x64.exe` |
| `zcode-unpacked/` | 官方产物② | Electron 安装目录(含 `resources/glm/zcode.cjs` 14.8 MB,逆向对象) |
| `asar-extracted/` | 官方产物③ | asar 解出源码 `out/{main,host,preload,renderer,scheduler}` |
| `ZCode-open/` | 参考源码 | 官方开源仓库 v3.14.0(Apache-2.0,含 fail-closed 占位包) |
| `tui-build/` | 参考源码 | ZCode TUI 前端包的独立可构建副本(86 个 `app-*.tsx`) |
| `zcode-cli-rs/` | 平行实现 | 纯 Rust 引擎 + TUI(`src/bin/zcode-rs.rs` 83 KB),不依赖 DSH |
| `zcode-cli/` | 历史残留 | 第二代实现(提取的官方 CLI + 归因伪装补丁),已被上面取代,可归档/删除 |
| `.zcode-rs/` | 运行残留 | Rust 版会话 jsonl,可删 |
| `ZCODE-PROVIDER-ANALYSIS.md` | 文档 | 插件专项分析 |

## 路径约定(2026-09-29 重组后)

- 插件默认 appServer 路径推导:`DSH_ZCODE_REPO`(= 工作区根)下 join `re-zcode/zcode-unpacked/resources`(见 `../dsh-dev/dpk/zcode-provider-dpk/src/src/openzcode-app-server.ts` 的 `defaultAppServerPaths()`)。
- 活动 profile `~/.dsh/profiles/web/cordis.patch.yml` 的 `cliPath` 已同步指向 `…\zcode-dev\re-zcode\zcode-unpacked\…`。
- `.debug/` 下的代码生成器(patch-*.py)与 e2e/probe 脚本已全部改指新路径。
