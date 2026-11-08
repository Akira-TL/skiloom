---
name: skiloom-manage
description: 通过公开 Skiloom CLI 执行安装、更新、移除及本地管理；修改已安装技能时先核实最小包与作用范围，按需建立项目级副本并 detach，再交给编写技能编辑，保留来源授权与所有权边界。
---

# Skiloom Manage

Use only the public Skiloom CLI/runtime for state-changing or maintenance operations. Prefer `--json` so Agent workflows consume the `SKILOOM-CLI-V1` envelope. Do not parse human terminal output when structured JSON is available.

## 定制已安装技能

用户要求“修改已安装技能”“改提交规则”或“按这个项目定制”时，先走本流程，再交给 `skiloom-author` 编辑。这样的请求授权为指定功能建立可编辑副本所必需的局部操作；不要求用户额外说出 `detach`。仅查看、诊断或研究实现时保持只读。

1. **确定实际修改对象。** 读取相关项目规范和实际技能文件，用公开 `status --json` 核对目标目录（Target）、包坐标、投影名称及所有权。区分独立依赖技能与包内脚本、引用文件；总入口的名称、目录层级和“子技能”的口头称呼都不能代替安装事实。仅在项目级查询不能确定现有安装时，再查用户级状态。

   ```text
   skiloom status --scope workspace --json
   skiloom status --scope user --json
   ```

2. **选择项目级副本。** 为当前项目定制时优先使用项目级安装。只有用户级安装时，先在目标项目工作目录通过公开安装流程建立同一包的项目级副本；优先复用已接受的来源种类与精确提交，不默认改用 `main` 或升级依赖。先生成完整计划，检查来源、依赖和投影影响，再按已有用户授权提交；计划含超出本次定制的升级、冲突或其他影响时，说明具体问题并只询问尚缺的决定。已有项目级副本则使用它。用户明确要求修改用户级安装时才选择用户级作用范围。项目级技能的发现与同名优先级由宿主决定，须核实当前执行环境是否支持；不能把安装成功直接等同于项目副本已经生效。

3. **只解除实际包的管理。** 独立安装的依赖技能按其自身包坐标处理，即使它由总入口间接安装。若所需功能只是总包内的脚本或引用文件，先说明它没有独立投影，使用包含它的项目级包副本；例如 Guard 若内置于 `akira`，就处理项目级 `akira`，不凭空构造 `akira-guard` 包。不能因找不到独立子包就对用户级总包执行 `detach`。

   项目级投影仍受管理时执行：

   ```text
   skiloom detach <package> --scope workspace --json
   ```

   `detach` 把指定包的投影原地转为用户维护的本地副本，保留内容与依赖位置；它不等于卸载，也不递归解除整套依赖。它没有 `--plan` 或 `--yes`。已经解除管理的副本直接进入下一步。

4. **确认后再编辑。** 检查命令返回的 `ok`、`result`、`warnings`，并通过公开状态确认选定作用范围中的对应投影已经解除管理。交给 `skiloom-author` 时明确包坐标、目标目录、副本路径与允许修改的文件。此后只编辑该本地副本；项目私有约定按用户要求留在项目内。修改用户级安装、上游源码、发布新版本或恢复之前误操作的安装均须有对应授权，不能作为本流程的隐含步骤。

完成标准：项目所需修改已经落在正确作用范围内、由用户维护的副本中；项目中的技能引用与脚本调用实际指向该副本，不能继续调用写死的用户级路径。向用户给出实际编辑路径、所有权状态，以及宿主是否需要重新加载。若来源或包身份仍不明确，停在受影响步骤，不能用新名称、额外安装或扩大解除范围来猜测解决。

## 解除管理后的恢复请求

用户要求撤销误操作的 `detach`、恢复原版本受管状态时，先核对当前 CLI 是否提供直接支持该状态转换的公开操作，以及它能否保持其他包的精确版本和其他目标目录不变。`rebind` 只修复已解除管理副本的位置绑定；`forget` 只释放关联；`sync/repair` 保持已接受的所有权状态。它们都不代表把本地副本重新交给 Skiloom 管理。

当前版本缺少直接恢复操作时，明确报告产品能力缺口并保留现场，将恢复需求交回 Skiloom 项目设计与实现流程。即使用户已授权恢复，也不得自行组合导出、搬移或删除本地副本、清除关联、修改导出清单和重新导入来模拟该转换；每一步使用公开命令，也不能代替产品对完整恢复操作的支持。恢复能力应由 Skiloom 负责精确版本选择、用户内容保护、所有权转换与中断后的状态协调，技能不维护另一套恢复流程。

## Candidate operations

Use these public commands for complete candidate operations:

```text
skiloom install <coordinate> --plan --json
skiloom update --plan --json
skiloom remove <coordinate> --plan --json
skiloom recover --plan --json
skiloom fork --plan --json
skiloom import <file> --plan --json
skiloom bootstrap --plan --json
```

For non-interactive commit, use the matching public command with explicit approval:

```text
skiloom install <coordinate> --yes --json
skiloom update --yes --json
skiloom remove <coordinate> --yes --json
skiloom recover --yes --json
skiloom fork --yes --json
skiloom import <file> --yes --json
skiloom bootstrap --yes --json
```

`--json` never implies `--yes`.

Release-tag retarget authorization is independent from ordinary approval. `--yes` does not authorize Release retarget; when the user has explicitly authorized that risk, use:

```text
skiloom update --yes --allow-release-retarget --json
```

Import merge is also a separate explicit boundary. `--yes` does not authorize merge; when the user explicitly chose merge, use:

```text
skiloom import <file> --merge --yes --json
```

## Exact-state maintenance

Use:

```text
skiloom sync --json
skiloom repair --json
```

These replay or repair the currently accepted exact state and do not create a new resolution candidate.

## Explicit local operations

Use:

```text
skiloom rename <package> <activation-name> --json
skiloom detach <package> --json
skiloom rebind <package> <activation-name> --json
skiloom forget <package> --json
skiloom observe <package> <name> --status <status> --json
skiloom observe <package> <name> --clear --json
```

These commands are the user's explicit local authorization and must not gain an extra hidden write path. `observe` records only machine-local `special` dependency observations for an already accepted Package; it never writes Skiloom-owned `software` observations, does not modify Target bytes, and does not advance Target Generation. It is not a Candidate operation, so do not add `--plan` or `--yes`.

## Transfer

Use:

```text
skiloom export <file> --json
skiloom export <file> --full --json
skiloom import <file> --plan --json
```

Never overwrite conflicts, invent auto-renames, or introduce a `--force` bypass.

## Bootstrap

Bootstrap is a normal candidate operation for one Target per invocation. Use the same Target selector rules as every other management command.

```text
skiloom bootstrap --plan --json
skiloom bootstrap --yes --json
```

Installing the Skiloom npm program never modifies a Skill Target by itself. Bootstrap must be an explicit public CLI action and first-party Packages have no privileged Target or installation path.

## Safety boundary

不得直接写入 `registry.sqlite3`、包存储、`.skiloom-state` 或目标目录内仍受管理的内容。公开 `detach` 成功后，用户维护的本地副本可以由 `skiloom-author` 直接编辑；安装状态仍只能通过公开命令修改。不得绕过 `operation.lock`、解析与来源授权、摘要核验、所有权检查、数据库先行的状态变更或恢复规则。公开命令失败时向用户说明结构化错误，不自行修改底层状态来绕过错误。
