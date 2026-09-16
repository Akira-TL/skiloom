# Skill 包与 GitHub 分发布局

状态：Superseded Working Draft

当前说明：本文保留为早期布局探索记录；其中固定项目 `.agents/skills`、项目级安装视图等内容不再是当前产品权威。现行 Package/Source/Target 规则见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)。

## 1. GitHub 是 v0 分发坐标系

Skiloom v0 的安装目标直接使用：

```text
<owner>/<repo>[/<package>]@<version-or-ref>
```

例如：

```text
akira-tl/matt-skills/ask-matt@1.4.0
akira-tl/matt-skills@1.4.0
```

- 指定 `package`：安装一个 Skill 及其 dependency closure；
- 省略 `package`：安装该 source 中发现的全部 Skill Package；
- Release 模式下 `@...` 是 GitHub Release version；
- Git 模式下 `@...` 是 branch/tag/commit 等 Git ref，最终必须锁定 exact commit。

未来 Registry 作为另一种 source model 单独设计，不提前把 Registry identity 强塞进 GitHub 模式。

## 2. 一个 Package 就是一个 Skill Root

Multi-Skill Package 不进入 v0。

最低合法 Package 只有：

```text
ask-matt/
└── SKILL.md
```

增强型 Package 可以是：

```text
ask-matt/
├── SKILL.md
├── skiloom-package.toml       # optional：结构化 Skill/software dependency
├── DEPENDENCIES.md        # optional：Agent-readable 特殊依赖说明
├── scripts/               # optional
├── references/            # optional
├── assets/                # optional
└── ...
```

固定关系：

```text
Package Root == Skill Root
Package Name == SKILL.md.name
```

`skiloom-package.toml` 和 `DEPENDENCIES.md` 都不是发现 Package 的前提。

## 3. Package discovery 只认 `SKILL.md`

Repository 可以在根目录提供可选 `skiloom-repo.toml`，仅用 `include` / `exclude` 过滤哪些 Package Root 参与 discovery。没有该文件时默认扫描整个版本化 source snapshot。详见 [`repository-discovery.md`](repository-discovery.md)。

### Git source

Git 模式不能假设 Package 位于 `skills/<name>` 或任何固定目录。

Skiloom 对 exact commit 的 **tracked Git tree** 枚举所有 `SKILL.md`：

1. 每个 `SKILL.md` 的父目录是 Package Root candidate；
2. 解析 frontmatter `name`；
3. 校验 `basename(root) == SKILL.md.name`；
4. repository 内同一个 `SKILL.md.name` 只能对应一个 candidate；
5. 如果 root `skiloom-repo.toml` 存在，先按 repository-relative Package Root path 应用 `include` / `exclude`；
6. 过滤后同一个 `SKILL.md.name` 仍只能对应一个 candidate；
7. 不同名称的 nested Package Root 可以同时存在；嵌套本身不构成 discovery error；
8. `skiloom-package.toml` 存在时读取增强依赖元数据；
9. `DEPENDENCIES.md` 存在时记录其 digest，并交给 Agent 做特殊依赖检查；
10. 指定 package 时按 `SKILL.md.name` 匹配；
11. 未指定 package 时选择全部最终合法 candidate；
12. 只有最终 Package Name 重复时返回 `AmbiguousPackageDiscovery`；
13. Lock 保存实际 `package-root`。

因此用户只需要知道：

```text
owner/repo/ask-matt@main --git
```

即使真实目录是：

```text
repo/agent-tools/routers/ask-matt/SKILL.md
```

也可以 clone 后自动发现。

### Release source

Release source 先把规范化 SemVer Release 解析为 actual tag + exact commit，再从该 repository snapshot 执行与 Git source 相同的 `SKILL.md` discovery。v0 不定义 per-Skill Skiloom Release Asset。

## 4. Release-first，Git source 显式启用

稳定路径：

```text
owner/repo[/package]@version
        ↓
SemVer GitHub Release
        ↓
actual tag + exact commit
        ↓
repository snapshot
        ↓
SKILL.md discovery
```

没有 Release 或明确需要源码版本时，用户显式进入 Git source，例如：

```text
skiloom install owner/repo/package@main --git
skiloom install owner/repo@<commit> --git
```

Skiloom 不静默把一次 Release 安装切换成 branch checkout。

## 5. Git source 使用机器级 Source Cache

无 Release 的 GitHub Skill 不应该每个项目重复 clone，也不应该把整个 repository 直接暴露到项目 `.agents/skills/`。

Skiloom 维护可丢弃、可重新获取的机器级 Git source cache，例如逻辑布局：

```text
~/.cache/skiloom/git/
└── github.com/
    └── <owner>/
        └── <repo>.git/        # bare/mirror-style repository cache
```

需要某个 ref 时：

```text
source cache fetch
  -> resolve ref to exact commit
  -> inspect tracked tree / materialize temporary checkout
  -> discover SKILL.md Package Roots
  -> snapshot selected Package Root(s)
  -> put immutable Package snapshot into machine Store
```

Source Cache 和 Package Store 不同：

```text
Source Cache
= Git objects / source acquisition acceleration
= 可删除、可重新 fetch
= 不直接激活给执行器

Package Store
= 已选择 Package Root 的不可变 snapshot
= 项目 Skill Library 的真实链接目标
= 用 content digest 去重
```

所以“GitHub 直接下载、没有 Release”仍然有类似其他包管理器的下载/cache 层，但项目最终依赖的不是一个 mutable clone，而是 exact commit 上的不可变 Skill snapshot。

## 6. 同 repository 的 Git source 复用同一 cache/commit

如果项目已经显式绑定：

```text
owner/repo/ask-matt@main --git
```

并解析到：

```text
commit = abc123
```

那么同 repository 的 sibling dependency：

```text
owner/repo/implement
owner/repo/tdd
```

都从同一个 cached repository / exact commit 中发现并 snapshot，不再次 clone，也不混用 GitHub Release。

一个 project resolution 内，同一个 `owner/repo` 只允许绑定一个 source snapshot：

```text
GitHub Release X
或
Git commit Y
```

不能一半 Release、一半 Git。

## 7. Router 与依赖

Router 是普通 Skill。

- `SKILL.md`：告诉 Agent 什么时候路由到哪些能力；
- 可选 `skiloom-package.toml`：让 Skiloom 自动安装相关 Skill dependencies。

因此：

```text
Skill Suite = Router Skill + dependency closure
```

没有 `skiloom-package.toml` 的 Router 也能安装，只是 Skiloom 不猜测它有哪些依赖。

## 8. 禁止跨 Package Runtime 隐式共享

Repository 可以共享 lint/test/release tooling，但 Skill runtime 不能依赖 Package Root 外的 sibling/shared 文件。

如果多个 Skill 需要同一能力：

- Agent 能力：拆成 Skill dependency；
- 外部软件/环境：Manifest `[software]` 或 `DEPENDENCIES.md`；
- Package 私有资源：复制/生成到各自 Package Root。

运行时共享必须显式建模，不依赖“刚好来自同一个 checkout”。

## 9. 项目 Skill 扁平激活

resolved Package 最终直接激活到：

```text
<project>/.agents/skills/<activation-name>
```

默认 `activation-name = SKILL.md.name`。Source coordinate 只保存在 `.agents/.skiloom/skiloom.lock`，不进入 executor-visible 目录层级。

不同 repository 可以各自拥有同名 Package，但如果两个 Package 默认都需要占用同一个 `.agents/skills/<name>`，则在 activation preflight 返回 `ActivationNameConflict`。Skiloom 必须提示用户为新安装项 rename 或放弃；不得自动覆盖或自动改名。

用户批准的 rename 记录在 `.agents/.skiloom/skiloom.toml [renames]`。rename 只改变项目 runtime Skill identity，不改变原始 Package Store `content-digest`；完整语义见 [`project-activation.md`](project-activation.md)。

## 10. Package 名称

Package 名称以 `SKILL.md.name` 为准。

校验：

```text
basename(Package Root) == SKILL.md.name
```

如果可选 Manifest 存在，不再要求它重复声明 `package.name`。

完整 GitHub 坐标仍来自外部 source context：

```text
owner/repo/<SKILL.md.name>@version-or-ref
```

## 11. 未来 Registry

未来可以增加：

```text
registry:scope/package@version
```

Registry 才需要独立 package ownership、namespace、publisher identity 和 package-specific version lifecycle。GitHub source 继续保留其直接坐标和 source cache 模型。