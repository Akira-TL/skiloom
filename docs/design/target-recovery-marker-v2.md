# `.skiloom-state` v2 公开格式

状态：Accepted

对应 ADR：ADR 0031

对应产品规范：[`skiloom-v0-product-contract.md`](skiloom-v0-product-contract.md)

V2 延续 V1 的 recovery-intent 定位，并增加 **managed projection ownership/materialization baseline**，用于安全同步落后 Target 副本。它仍不是完整 exact dependency Lock。

## 1. Format 与兼容性

Writer 固定生成：

```toml
format = "SKILOOM-STATE-V2"
```

当前 parser 必须同时接受：

```text
SKILOOM-STATE-V1
SKILOOM-STATE-V2
```

V1 的 requirements / projection-overrides / detached 语义全部保持。

## 2. V2 顶层成员

V2 顶层必须且只能包含：

```text
format
target-id
generation
requirements
projection-overrides
managed
detached
```

其中前三项必填；四个数组成员均可为零条。

## 3. `[[managed]]`

每个 accepted managed projection 保存一条 ownership baseline。

普通 link 示例：

```toml
[[managed]]
package = "akira-tl/skills/ask-matt"
activation-name = "ask-matt"
materialization = "symlink"
baseline-package-root = "skills/ask-matt"
baseline-content-digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

transformed copy 示例：

```toml
[[managed]]
package = "akira-tl/skills/router"
activation-name = "router-local"
materialization = "copy"
baseline-package-root = "skills/router"
baseline-content-digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
baseline-transform-json = "{\"dependencyRoutes\":[...]}"
```

字段约束：

- `package`：canonical Package Coordinate；
- `activation-name`：合法 projection name；
- `materialization`：仅 `symlink | junction | copy`；
- `baseline-package-root`：合法 Package Root；
- `baseline-content-digest`：canonical `sha256:<64 lowercase hex>`；
- `baseline-transform-json`：可选 canonical JSON string。

规则：

- 同一 Package 最多一条；
- `symlink` / `junction` 不允许 `baseline-transform-json`；
- `copy` 若实际 projection 没有 transform，同样省略；
- writer 按 Package Coordinate raw UTF-8 顺序稳定排序。

## 4. Managed baseline 的边界

`[[managed]]` 只用于证明 lagging copy 中旧 projection 的 ownership/bytes。

它不保存也不决定：

```text
Release version/tag
Git ref
exact commit
source authorization
dependency graph
resolver candidate
transitive resolution
```

验证时由 `baseline-content-digest` 找到 immutable Package Store entry，并按 materialization + canonical transform 重建旧期望。

Store baseline不存在、损坏，或 live bytes 与 baseline 不一致时，sync fail closed。

## 5. V1 lagging copy

V1 没有 `[[managed]]`。

因此：

- current-generation V1 copy 可以对照当前 Registry exact state 验证并登记；
- lagging V1 copy 若存在 managed projection，则不能安全证明旧 ownership，必须 fail closed；
- detached baseline 继续按 V1 规则有效；
- 成功写回 current state 后 marker 升为 V2。

## 6. Canonical writer 顺序

顶层稳定顺序：

```text
format
target-id
generation
requirements
projection-overrides
managed
detached
```

数组排序：

- requirements：kind + coordinate；
- projection-overrides：Package Coordinate；
- managed：Package Coordinate；
- detached：Package Coordinate。

## 7. 与 Target copy sync 的关系

V2 marker generation 是该目录副本最后成功同步的 generation。

lagging sync：

```text
V2 managed/detached baseline
→ verify old ownership
→ current Registry TargetPlan
→ preflight
→ one-way reconcile
→ observe location at current generation
→ rewrite V2 marker
```

Marker target-id/generation 单独从不构成 overwrite authority。

## 8. 一句话边界

```text
.skiloom-state V2
= V1 recovery intent
+ managed projection ownership/materialization proof

!= exact source lock
!= resolver history
!= user-content backup
```
