# @local/dsh-reverse-skill

DSH 适配层：把客户端中立的 [reverse-skill](https://github.com/zhaoxuya520/reverse-skill) 安全技能路由包，做成一个标准的 DSH 插件包（bundle），安装后本 profile 的每个会话都能在标准技能目录里看到它的技能。

仓库本身保持唯一真相源：本包**不复制、不修改**仓库内容，只在运行时从 `repoRoot` 指向的检出目录读取 `SKILL.md`。provider 引擎在共享包 [@local/dsh-skill-dir](../dsh-skill-dir) 里，本包只声明 `reverse-skill` 这个身份与要暴露的模块目录。

**范围：只保留逆向功能（17 个技能）。** 示例/演示类内容（`CTF-Sandbox-Orchestrator/**` 42 个竞赛场景、`examples/ctf-demo`、`reports/`、`docs/reviews|plans|superpowers`、`skills/tests/**`）以及非逆向模块（渗透/取证/情报/编排/文档）都不进技能目录。逐条依据见
[notes/reverse-skill-能力分析.md](../../notes/reverse-skill-能力分析.md)。

## 它做什么

- 在 `ctx.skills` 上注册一个名为 `reverse-skill` 的 skill provider（实测 17 个技能）。
- 递归扫描 `repoRoot` 下 config 里 `roots` 列的每个模块目录里的 `SKILL.md`，每个文件注册为一个 DSH 技能。
- 每个技能的 `resourceBase` 就是它自己的目录，因此正文里的相对引用（`references/…`、`../field-journal/…`、`../tool-index.md`）可以继续按仓库原样读取。
- 技能正文**按需加载**：只有模型调用 `skill` 工具或用户 `/技能名` 时才读取全文。
- 支持仓库里的 frontmatter 形态：普通标量、引号标量、`|` / `>` 块标量、`metadata.user-invocable`。

## 范围与配置（`cordis.patch.yml`）

`roots` 就是白名单，逐项是仓库相对目录：

```yaml
roots:
  - skills/reverse-engineering        # 含嵌套的 dsl-vm-reverse
  - skills/ida-reverse
  - skills/ghidra-reverse
  - skills/radare2
  - skills/binary-ninja-reverse
  - skills/binary-diff
  - skills/protocol-reverse
  - skills/apk-reverse
  - skills/mobile-reverse
  - skills/js-reverse
  - skills/macos-reverse
  - skills/dotnet-reverse
  - skills/go-rust-reverse
  - skills/browser-extension-reverse
  - skills/malware-analysis
  - skills/edr-bypass-re
```

- **加模块**：追加 `skills/<模块名>`。
- **边界模块**（交付物是利用而非理解目标）：`firmware-pentest`、`hardware-security`、
  `thick-client`、`patch-diff-exploit`、`pwn-chain`，需要就加。
- **入口 router**（`skills/SKILL.md` 单文件）：`roots` 只能指目录，加不进来；重启后可用
  共享 provider 的 `include: [reverse-skill-router, …]` 白名单表达。
- 改动后生效：`set_bundle enabled=false` → `set_bundle enabled=true`。

**两种改动的生效范围不同**：config 改动会热生效（实测 `roots` 一换，技能目录立刻变），
JS 代码改动不会——进程的 ESM 模块缓存保留首次加载的代次，需要重启 harness。

## 安装

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

`install_bundle` 通过 pnpm 写入 `link:` 依赖并选中 bundle 层。前提是 profile 里其余依赖也能被解析——
本 profile 原先的 `zcode-provider: "1.0.0"`（registry 上不存在的本地版本）会让每次 `pnpm add` 失败，
现已改为 `link:` 指向其源码仓库，详见 [zcode-provider README](../../../Dev-ws-next/repos/zcode-dev/dsh-plugin-zcode-provider/README.md)。

手工安装（不经 pnpm）需要三步，缺一不可：

```powershell
# 1) 让包能被 profile 解析
New-Item -ItemType Junction -Path "$env:DSH_PROFILE_DIR\node_modules\@local\dsh-reverse-skill" -Target <本目录绝对路径>
# 2) 共享 provider 也要能被解析（本包 import '@local/dsh-skill-dir'）
New-Item -ItemType Junction -Path "<plugins>\node_modules\@local\dsh-skill-dir" -Target <plugins>\dsh-skill-dir
```

```jsonc
// 3) $DSH_PROFILE_DIR/package.json：登记依赖并选中 bundle 层
"dependencies": { "@local/dsh-reverse-skill": "link:../../../…/plugins/dsh-reverse-skill" },
"dsh": { "profile": { "bundles": [ …, "@local/dsh-reverse-skill" ] } }
```

**第 3 步不能省**：`plugin_manager list_bundles` 的 `installed` 字段取自 profile `dependencies`，而插件页只列出 `installed || optional || error` 的条目。只做软链接而不登记依赖时，插件照常工作、技能照常出现在技能目录里，但插件页看不到卡片。

两种方式都把它登记为 profile 的一个 bundle 层，插入的 Loader 行 id 是 `dsh-reverse-skill`。

## 配置（`cordis.patch.yml` 里的行 config）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `repoRoot` | 必填 | reverse-skill 检出的**绝对路径**，必须包含 `skills/` 目录 |
| `roots` | `['skills']` | 相对 `repoRoot` 的技能根目录，递归查找 `SKILL.md`（最多 4 层） |
| `extraRoots` | `[]` | 追加的根目录；加上 `CTF-Sandbox-Orchestrator` 可暴露 42 个竞赛场景技能 |
| `rank` | `600` | 同名技能的优先级，数字小者胜；600 与 `BUNDLED_SKILL_RANK` 同级，保证项目/用户技能优先 |

`repoRoot` 缺失、不是绝对路径、或没有 `skills/` 时，插件在激活阶段就抛出可读错误（`plugin_manager list_plugins` 会显示该行失败原因），而不是静默返回空目录。

## 与仓库授权模型的边界

本包只做**读取与暴露技能**，不执行仓库脚本，也不改变仓库的门禁语义（`RULES.md`、`scope.md`、`case-init`/`case-guard` 仍由技能正文要求模型执行）。`skills/SKILL.md`（技能名 `reverse-skill-router`）是仓库自带的入口技能，它会引导模型先跑平台原生路由与授权门禁；DSH 侧只是让它可被检索到。

## 优先级

默认 `rank: 600`，与 DSH 内置 `bundled` 技能同级、排在项目（100/200）和用户（300–500）技能之后：同名时项目/用户技能获胜。若要让本包覆盖用户同名技能，把 `rank` 调到 400 以下。

## 卸载

停用（立即生效，保留文件）：

```text
plugin_manager action=set_bundle target=@local/dsh-reverse-skill enabled=false
```

链接安装时该 bundle 的 `removable` 为 `false`，所以 `remove_bundle` 会以 `not-removable` 拒绝；停用后再删除 profile 里的 junction 即可：

```powershell
Remove-Item "$env:DSH_PROFILE_DIR\node_modules\@local\dsh-reverse-skill"
```

若是通过 `install_bundle` 正常安装的，则 `remove_bundle` 可用：

```text
plugin_manager action=remove_bundle target=@local/dsh-reverse-skill
```

## 自检

`test/provider.test.mjs` 直接以假 ctx 调用 `apply()`，校验发现数量、frontmatter 解析（含块标量与 BOM 文件）、去重与 `get()` 正文加载：

```text
node test/provider.test.mjs "C:\path\to\reverse-skill"
```
