# Package Manifest v0 设计背景

状态：Superseded

当前说明：本文只保留早期 Package Manifest 设计背景。当前产品权威见 [`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)；仍有效的 Schema 1 细节保留在 [`package-manifest-schema.md`](package-manifest-schema.md)，但其中旧 Core/conformance 措辞不再具有当前权威。

## 1. 定位

`skiloom-package.toml` 是 **可选的 Skiloom 增强元数据**，不是 Skill Package 的准入条件。

Skiloom 判断一个目录是否为可安装 Skill Package 的最低条件只有：

```text
<skill-root>/SKILL.md
```

只要 `SKILL.md` 合法，这个目录就是一个 Skill Package candidate。Package 名称直接来自 `SKILL.md` frontmatter 的 `name`。

`skiloom-package.toml` 仅在作者希望声明以下结构化信息时存在：

- Skill dependencies；
- Skiloom 可基础探测的常见软件 requirements；
- 将来经过协议讨论加入的其他 Skiloom 扩展元数据。

它不复制 `SKILL.md` 已经提供的名字、描述、Agent routing 等信息，也不承担 GitHub owner/repository 或 Release version 的来源职责。

## 2. Package Root

最小 Skill Package：

```text
ask-matt/
└── SKILL.md
```

带 Skiloom 增强信息：

```text
ask-matt/
├── SKILL.md
├── skiloom-package.toml       # optional
├── DEPENDENCIES.md        # optional
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

按照 Agent Skills 的目录约束，Package Root basename 应与 `SKILL.md.name` 一致；Skiloom 将该约束作为 Package validation 的一部分。

## 3. Manifest 最小格式

如果作者只需要声明 Skill dependencies：

```toml
schema = 1

[dependencies]
"akira-tl/matt-skills/implement" = "^1.4"
"akira-tl/matt-skills/wayfinder" = "^1.4"
```

如果还需要 Skiloom 基础检查常见软件：

```toml
schema = 1

[dependencies]
"akira-tl/matt-skills/implement" = "^1.4"
"akira-tl/matt-skills/wayfinder" = "^1.4"

[software]
git = ">=2.40"
gh = ">=2.45"
```

Package 没有这些增强元数据时，可以完全没有 `skiloom-package.toml`。

## 4. 为什么 Manifest 不再保存 `name` / `version`

### Package name

名称已经由标准 `SKILL.md` 提供：

```yaml
---
name: ask-matt
---
```

再在 `skiloom-package.toml` 中复制：

```toml
[package]
name = "ask-matt"
```

只会制造两个 source of truth，因此 v0 不需要这个字段。

### Version

GitHub Release 模式中的版本来自 repository Release：

```text
akira-tl/matt-skills/ask-matt@1.4.0
                             ^^^^^
                         GitHub Release
```

Git source 模式中的可重建身份来自 exact commit：

```text
requested ref -> exact commit
```

因此 v0 也不要求 Package 自己重复声明版本。

未来如果建立独立 Skiloom Registry，并允许 Package version 与 repository lifecycle 解耦，再为 Registry source model 设计独立 version/identity 字段。

## 5. `[dependencies]`

Skill dependency 使用 GitHub 坐标：

```toml
[dependencies]
"akira-tl/matt-skills/implement" = "^1.4"
"akira-tl/skills/browser-access" = ">=2.0 <3"
```

规则：

- key 必须是 `<owner>/<repo>/<package>`；
- Package dependency 必须精确到一个 Skill，不允许写 repository-wide target；
- value 是 GitHub Release version range；
- Release source 默认按 version range 求解；
- 如果当前 project resolution 已显式把某个 repository 绑定到 Git source，则同 repository dependency 复用该 exact commit，不再从 Release 混装；
- 跨 repository dependency 若没有显式 Git source，仍按 Release 模式解析。

没有 `skiloom-package.toml` 的 Skill 被视为没有 Skiloom 可见的结构化 Skill dependency，Skiloom 不猜测依赖。

## 6. Router

Router 不是特殊 Package 类型。

Router 的行为写在 `SKILL.md`；如果作者希望 Skiloom 自动安装 Router 会用到的其他 Skill，则在可选 Manifest 中声明：

```toml
[dependencies]
"akira-tl/matt-skills/implement" = "^1.4"
"akira-tl/matt-skills/wayfinder" = "^1.4"
"akira-tl/matt-skills/triage" = "^1.4"
```

因此：

```text
Skill Suite = Router Skill + dependency closure
```

没有 Manifest 的 Router 仍然可以被安装，只是 Skiloom 不会自动知道它需要哪些 sibling Skill。

## 7. 版本范围

Release dependency 暂按以下 grammar 继续设计：

- `1.4.0`；
- `^1.4` / `^1.4.0`；
- `~1.4` / `~1.4.0`；
- `>=1.4 <2`；
- `>=1 <2 || >=3 <4`；
- `*`。

动态标签如 `latest` 不进入 Manifest。

## 8. `[software]`

只声明 Skiloom 内建只读 probe 能基础检查的常见软件：

```toml
[software]
git = ">=2.40"
gh = ">=2.45"
python = ">=3.11"
node = ">=22"
```

Skiloom 只负责基础发现与状态记录，不负责安装、升级、配置或选择系统 package manager。

如果没有 `skiloom-package.toml`，Skiloom 就没有结构化 common software requirement 可自动 probe；如 Package 额外提供 `DEPENDENCIES.md`，Agent 仍可按其中说明检查复杂依赖。

## 9. `DEPENDENCIES.md`

`DEPENDENCIES.md` 同样是可选增强文件，不是 Package 准入条件。

存在时它属于不可变 Package payload，只写特殊依赖、检查方法与处理边界。当前宿主状态写入 `.agents/.skiloom/dependencies.lock`，永不回写 Package 文件。

## 10. 校验规则

所有 Skill Package：

1. 必须存在合法 `SKILL.md`；
2. Package Root basename 与 `SKILL.md.name` 一致；
3. 不同名称的 nested Skill Root 可以同时存在；嵌套本身不构成 Package validation error；
4. Package runtime 不允许依赖 Root 外隐藏共享文件，也不能因为目录嵌套而把另一个已发现 Skill Package 当作隐式依赖。

当 `skiloom-package.toml` 存在时，再额外校验：

1. `schema` 已知；
2. dependency 坐标合法；
3. dependency version range 可解析；
4. `[software]` 语法合法。

当 `DEPENDENCIES.md` 存在时，Skiloom 将其 digest 记录到 dependency state，用于判断本地检查状态是否失效；缺失该文件不影响 Package 安装。