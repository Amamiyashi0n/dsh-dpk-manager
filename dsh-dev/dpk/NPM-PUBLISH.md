# 往 npm 推送 `dsh-dpk-manager` 的经验

> 记录时间：2026-10-03，随 **2.1.11** 的发布一起写下来；同日 **2.1.12** 补掉了当时刻意留下的
> `repository.url` 警告（见 §5.3）。
> 适用对象：本工作区里**唯一**会发布到 npm 的包（`dpk-manager/`）。
> 事实来源：全部为本次实测输出，不是推测。

---

## 0. 先认清哪条通道发什么

三个包走**两条不同的分发通道**，不能混：

| 包 | 分发通道 | 原因 |
| --- | --- | --- |
| `dsh-dpk-manager` | **npm + `.dpk` 都可以** | 普通 npm 包，`private` 未设 |
| `zcode-provider` | 只有 `.dpk` | `"private": true`，npm 直接拒发 |
| `dsh-reverse-skill` | 只有 `.dpk` | `"private": true`，npm 直接拒发 |

两个 `private: true` 的包不是"忘了配"，是刻意的（zcode-provider 的 README 写明"分发仅走 `.dpk`，
不发布 npm"）。**不要为了图省事把它们改成公开**。

而且 **npm tarball 与 `.dpk` 的内容并不相同**：

| | 收录规则 | 2.1.11 实际 |
| --- | --- | --- |
| npm tarball | 按 `package.json` 的 `files` 字段 | 21 个文件 / 64.0 kB |
| `.dpk` | **整棵树全量**（不读 `files`，只排除 `dist/`、`node_modules/`、`.git/`） | 36 个文件 / 101.9 kB |

所以两条通道要**各自出**：`.dpk` 走 `node scripts/pack-all.mjs`，tarball 走 `npm publish`。

---

## 1. 标准流程（可复制）

```powershell
cd dsh-dev\dpk\dpk-manager

# 1) 确认版本号没被占用（看线上最新）
npm view dsh-dpk-manager version --registry=https://registry.npmjs.org/

# 2) 看会发什么，并记下 shasum（关键：这一步不落盘）
npm pack --dry-run

# 3) 发布（不可逆）
npm publish --registry=https://registry.npmjs.org/

# 4) 复核（元数据传播有延迟，见下）
npm view dsh-dpk-manager@<version> version dist.shasum --prefer-online --registry=https://registry.npmjs.org/
```

### 本次 2.1.11 的实测记录

```
npm pack --dry-run  →  shasum: e8fd621ec2545400f03217af32f4055a2b1cf68f
                       21 files, package size 64.0 kB, unpacked 200.7 kB
npm publish         →  + dsh-dpk-manager@2.1.11
npm view @2.1.11    →  dist.shasum = e8fd621ec2545400f03217af32f4055a2b1cf68f   ← 与上面一致
                       dist-tags = { latest: '2.1.11' }
```

### 2.1.12 的实测记录（消掉 `repository.url` 警告）

```
npm pkg fix         →  只改 repository.url 一行(冒号→斜杠),字段集合 15 个不变
node --test         →  108/108(升版本号会让 generator 闸门先红,见 §5.3)
node scripts/pack-all.mjs
                    →  dsh-dpk-manager@2.1.12  digest a8e7f724431f…
                       (zcode-provider@2.6.10 与 dsh-reverse-skill@2.0.1 的 digest 不变 = 可复现)
npm pack --dry-run  →  shasum: 4114d2bcc053b6140ba4df16a519820daa0adb09   21 files
npm publish         →  + dsh-dpk-manager@2.1.12
                       发布输出里的 shasum 与 dry-run 相同,且**不再出现 warn publish**
```

**shasum 相等是唯一能证明"线上那份 == 本地核对过的那份"的证据。** 只要看过 `--dry-run` 的
shasum，发布后就必须比它；不相等说明发的不是你以为的那棵树，立刻停下来查。

---

## 2. 两个真正踩到的坑

### 坑一：`npm whoami` 说没登录，其实凭证是好的

本次第一次判断登录态时得到：

```
npm config get registry  →  https://registry.npmmirror.com/     ← 只读镜像站
npm whoami               →  npm error code ENEEDAUTH ... need auth
```

看着像"没有凭证"，实际原因是 **`whoami` 问的是配置里的 registry，也就是那个镜像站**，而镜像站
不接受登录。凭证本身完好，就在 `~/.npmrc` 里：

```
registry=https://registry.npmmirror.com/
//registry.npmjs.org/:_authToken=…            ← 51 字符，按 registry 分域存放
```

正确的判断方式（显式指定 npmjs）：

```powershell
npm whoami --registry=https://registry.npmjs.org/     # → amamiyashion
```

**教训**：
- `~/.npmrc` 里的 `_authToken` 是**按 registry 前缀分域**的（`//registry.npmjs.org/:_authToken`），
  所以默认 registry 指向镜像站并不影响发布到 npmjs；
- 排查"未登录"时先看 `npm config get registry`，别急着 `npm login`；
- 包内 `publishConfig.registry` 已指向 npmjs.org，但**显式带 `--registry` 更稳**，避免误发镜像。

### 坑二：`npm pack` 落下的 `.tgz` 会被下一次 `.dpk` 吞进去

`npm pack`（**不带** `--dry-run`）会在包目录落盘 `dsh-dpk-manager-<version>.tgz`。而 `.dpk`
打包器是整棵树全量收录——`.tgz` 不在它的禁用目录（`dist/`、`node_modules/`、`.git/`）里，
于是会被卷进下一个 `.dpk`。这与当年的嵌套归档事故是**同一类**（当时是 `.dpk` 卷 `.dpk`，
现在会变成 `.dpk` 卷 `.tgz`）。

**纪律**：一律用 `npm pack --dry-run`；若不慎落盘，发完立刻清掉：

```powershell
Get-ChildItem dsh-dev\dpk\dpk-manager -Filter *.tgz        # 应为空
```

---

## 3. 发布后的传播延迟（别误判成失败）

发布成功时 npm 自己就提示了：

```
npm notice Your package is being processed and may take a few minutes to become available.
```

紧接着 `npm view` **确实仍报 404**：

```
npm error 404 No match found for version 2.1.11
```

几分钟后再查就正常了（`latest: 2.1.11`）。

**教训**：发布后的 404 不能当作失败证据。判断成功以 `npm publish` 的
`+ <name>@<version>` 行为准，然后**过几分钟再核对 shasum**；必要时加 `--prefer-online`
绕过本地缓存。

---

## 4. 发布前检查清单

- [ ] 该包**不是** `private: true`；
- [ ] 目标版本号在线上不存在（`npm view <name> versions`）；
- [ ] 测试全绿——`.dpk` 那条通道有 `pack-all.mjs` 把关，**npm 这条没有**，`npm publish`
      不会替你跑测试（本包没有 `prepublishOnly`）；
- [ ] `npm pack --dry-run` 看过内容，**并记下 shasum**；
- [ ] 包目录内无 `.tgz` / `.dpk` 残留；
- [ ] 确认发布**之后**不再改动包内任何文件（要改就升版本号，见第 5 节）。

## 5. 三条硬约束

1. **发布不可逆**：撤销窗口很短，版本号不能复用。所以顺序永远是
   先测试 → 先 `--dry-run` → 先记 shasum → 再发布。
2. **发布后不要再改动包内任何文件**（不只是 `package.json`）：`.dpk` 的 `integrity.digest`
   覆盖包内每个文件，改一个字节，同一个版本号就会对应两个不同的 `.dpk`，store 里会出现两份，
   也没人分得清哪份是"发出去的那份"。要改就**升版本号**。

   这条不是纸上规矩——写本文档时就踩了一次：我顺手在 `dpk-manager/README.md` 里加了一行指向
   本文的指引，随即意识到它在**已发布的包内**，于是撤回。撤回后复核（重算 digest 必须仍等于
   出货那份）：

   ```powershell
   node -e "import('./dsh-dev/dpk/dpk-manager/lib/pack.mjs').then(async ({packDirectory}) => console.log((await packDirectory('dsh-dev/dpk/dpk-manager')).manifest.integrity.digest))"
   # 2.1.11 应为 be3eee516e69967786237e0c8762de3f268252f26442e3c79c9ca6992881c121
   ```

   所以维护者指引这类文字，**放在包外**（本文件与上级 `README.md`），不要放进包里。

3. **已于 2.1.12 修掉**：2.1.11 的 `npm publish` 报过一条警告：

   ```
   npm warn publish "repository.url" was normalized to "git+ssh://git@github.com/Amamiyashi0n/dsh-dpk-manager.git"
   ```

   原文写的是 `git+ssh://git@github.com:Amamiyashi0n/…`——把 scp 简写（`git@host:owner/repo`，冒号
   分隔）塞进了 URL（`git+ssh://`，其中 `host:xxx` 的冒号表示端口）。npm 只把**注册表元数据**
   规范化成斜杠形态：实测线上 tarball 内的 `package.json` 一字未改，因此**不影响产物 shasum**。

   当时**故意留到下一个版本**处理，因为 2.1.11 已经发出去了，改 `package.json` 会让本地这棵树
   不再等于线上那个 2.1.11。2.1.12 用 `npm pkg fix` 消掉它（只改那一行，15 个字段集合不变）。

   顺带记住这个耦合：**升 `package.json` 的版本号会让 `node --test` 先红**——
   `lib/dpk-manifest.mjs` 的 `DPK_TOOL_VERSION`（进而 `generator` 写出的 `dpk/<version>`）必须与
   `package.json` 同版本，测试专门锁这条不变量。升版本时两处一起改（`SPEC.md` 的示例清单同理）。

---

## 6. 为什么值得发 npm（不只是"顺手"）

发布不只是多一条分发渠道，它解决了一个**导入通道解决不了的问题**：

> 停留在 dpk-manager **2.1.0** 的机器，导入任何现代 `.dpk` 都会失败——报
> `name: dpk.json says … package.json says @local/…`（2.1.10 起归档携带包本名，
> 而 2.1.0 的读取器要求两侧都带作用域）。这类机器**无法用 `.dpk` 自我升级**。

而 npm 上按名字安装不走 dpk 的校验路径，于是它是这类机器**唯一的升级通道**：

> 插件页 → 添加插件 → 填 `dsh-dpk-manager` → 安装

反过来，**只发 npm 也不够**：`.dpk` 通道才能携带 `@local/*` 的第三方插件
（那两个包本来就不上 npm）。两条通道是互补的，不是二选一。

---

## 7. 一句话总结

推送本身只有一条命令，真正的成本全在**周边**：认清只有哪个包能发、认准 registry 与凭证分域、
用 `--dry-run` 的 shasum 做发布前后比对、发布后耐心等元数据传播、以及**别让 npm 的副产品
（`.tgz`）混进 `.dpk` 的全量打包**。
