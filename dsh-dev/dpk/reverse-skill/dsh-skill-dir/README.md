# @local/dsh-skill-dir

DSH 技能 provider 的共享实现:把一个 `SKILL.md` 目录树暴露成 DSH 技能。本机的 bundle
([@local/dsh-reverse-skill](../dsh-reverse-skill))基于它,声明自己的 provider 名称与扫描根目录。

## 导出

| 导出 | 作用 |
| --- | --- |
| `registerSkillDir(ctx, config)` | 解析配置 → 在 `ctx.skills` 注册 provider,返回解析后的设置 |
| `resolveSkillDirSettings(config)` | 只做校验与归一化(缺失 `repoRoot`、相对路径、越界根目录都会抛出可读错误) |
| `createSkillDirProvider(ctx, settings)` | 构造 provider 对象,便于自检与复用 |

## config

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `providerName` | `dsh-skill-dir` | provider 名称,同时写进每个技能的 `provider` 字段 |
| `repoRoot` | 必填 | 技能仓库的**绝对路径**,必须包含 `skills/` 目录 |
| `roots` | `['skills']` | 相对 `repoRoot` 的扫描根,递归查找 `SKILL.md`(最多 4 层) |
| `extraRoots` | `[]` | 追加扫描根 |
| `include` | 不限 | **白名单**:只暴露这些技能名(kebab-case),其余跳过 |
| `exclude` | 无 | **黑名单**:这些技能名不暴露 |
| `rank` | `600` | 同名技能优先级,数字小者胜;600 让项目/用户技能优先 |
| `source` | `custom` | 技能来源标签 |

`include` / `exclude` 在发现阶段按 `SKILL.md` 的 `name` 过滤,`exclude` 优先于 `include`;
两者都是可选的,非法项(非数组、非 kebab-case)会在激活时抛错。
**注意**:改 config 会热生效,但改本包的 JS 代码不会——进程的 ESM 模块缓存保留首次加载的
那一代,需要重启 harness 才加载新代码。

## 行为

- **懒加载**:`list()` 只读每个 `SKILL.md` 的头部(32 KiB)解析 frontmatter;正文由 `get()` 按需整篇读取。
- **frontmatter 子集**:普通/引号标量、`|`/`>` 块标量、纯标量续行、一层嵌套映射(`metadata`),
  并处理 UTF-8 BOM;映射 `metadata.user-invocable` / `disable-model-invocation` 到 DSH 的 `invocation`。
- **歧义处理**:缺 frontmatter、缺 `name`/`description`、名字不合 kebab-case 的文件跳过并 warn;
  同名技能先到先得(按根目录顺序),其余 warn。
- **资源定位**:每个技能的 `resourceBase` 是它自己的目录,正文里的相对链接(`references/…`、
  `../field-journal/…`)可直接按仓库原样解析。
- 单个目录读取失败只记 warn 并把该次 `list()` 标为 `complete: false`,不影响其他根。

## 自检

```text
node test/provider.test.mjs <reverse-skill 检出绝对路径>
```

覆盖:配置校验、88/46/42 三个目录规模、块标量与 BOM、invocation 映射、懒加载正文、
两个 bundle 的目录互不重叠。
