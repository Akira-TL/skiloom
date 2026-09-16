# ADR 0011：Project Intent 与 Confirmed Resolution 分离

- 状态：Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：Project Intent、Project Lock 与 frozen replay 已退役；直接安装要求、本机精确状态、整图更新与 sync/repair 语义见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

Project Manifest 中的 version requirement 表达“项目允许什么”，而 Project Lock 表达“项目已经确认使用什么 exact result”。早期设计允许普通 `sync` 在 Manifest requirement 变化后重新解析变化部分并直接重写 Lock，这会把“恢复已确认环境”和“接受新的依赖解析结果”混成同一个动作，也使一次普通同步可能隐式升级 Release 或移动 Git ref。

对于 Agent Skill 依赖环境，可复现性比自动追新更重要。已经存在的 Lock 应被视为项目已经接受的 exact resolution，而不是 resolver 的缓存提示。

## 决定

Project state 固定分成两层语义：

```text
Project Intent
= `.agents/.skiloom/skiloom.toml [skills]`
= 用户允许的 top-level requirements

Confirmed Resolution
= `.agents/.skiloom/skiloom.lock`
= 用户已经接受的 exact repositories / packages / dependency graph
```

### `sync`

当 Lock 已存在时，普通 `sync`：

1. 解析当前 Project Intent；
2. 与 Lock 的 canonical Requirement Set 比较；
3. 若一致，只按 Lock 中的 exact repository source、Package Root、content digest 与 dependency graph 恢复/校验项目；
4. 不枚举新的 Release、不重新选择 compatible version、不把 Git ref 移到新 commit、不重写为新的 dependency graph；
5. 若 Project Intent 与 Lock requirement 不一致，返回 `ProjectIntentLockMismatch`，不部分求解、不修改 Lock。

因此普通 `sync` 本身就是 lock-preserving operation。

### 初次解析

项目没有 Lock 时，可以进入 initial resolution，但生成的 exact result 在写成正式 Lock 前必须经过显式接受。交互式 CLI 可以展示 plan 并要求确认；非交互实现必须使用明确的接受策略，不能把“运行普通同步”解释成隐式授权。

### `update`

只有显式 resolution-changing operation（例如 `update`）可以：

1. 根据当前 Project Intent 重新求解 candidate resolution；
2. 展示旧 Confirmed Resolution 与 candidate 的 repository version/tag/commit、Package graph 和 content identity 差异；
3. 在用户或显式自动化策略接受后，原子写入新的 Lock；
4. 再按新的 Confirmed Resolution 执行 Store/activation reconciliation。

如果 candidate 未被接受，原 Lock 和当前 activation 都保持不变。

### Frozen mode

Frozen mode 用于 CI / automation 明确要求“必须已有且完全匹配的 Confirmed Resolution”：

- Lock 缺失：失败；
- Requirement Set 不一致：失败；
- exact locked graph 无法验证/恢复：失败；
- 永不创建或更新 Lock。

普通 `sync` 在“已有且匹配 Lock”时与 frozen mode 使用同一 exact resolution；Frozen mode 的额外意义是禁止初次解析和任何需要确认的新 resolution。

## 结果

- `skiloom.toml` 是允许范围，不是当前安装版本；
- `skiloom.lock` 是已确认结果，不是 resolver cache；
- `sync` 负责恢复/校验，不负责升级；
- `update` 负责产生 candidate，并且只有显式接受后才改变 Lock；
- CI 可以使用 frozen mode 保证项目没有隐式 resolution transition；
- Git branch/ref 作为 Project Intent 时，已有 Lock 仍固定 exact commit，只有显式 update 才允许 ref 前进。
