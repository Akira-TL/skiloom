# ADR 0031：v0 lagging Target sync 使用 Marker managed ownership baseline

- 状态：Accepted
- 日期：2026-09-20
- 对应 Wayfinder：#143 `Decide managed ownership proof for lagging Target sync`
- 实现依赖：#141 copied Target location sync

## 背景

Skiloom v0 已接受两个同时成立的产品边界：

1. 同一个 `target-id` 可以对应多个 Target 副本；落后副本可以显式单向 `sync` 到当前 Registry state，或者 `fork` 为新身份；
2. `.skiloom-state` 是 recovery intent，不是完整 exact resolution lock；数据库丢失恢复必须重新解析。

实现 #141 时发现，仅靠现有 `SKILOOM-STATE-V1` 无法安全完成一般 lagging-copy sync。

V1 保存：

- target-id / generation；
- Direct Install Requirements；
- sparse projection rename；
- Detached Override exact baseline。

但它**不保存 managed projection 的旧 ownership/materialization baseline**。

Registry advance 后，lagging copy 中的 managed projection 可能是：

- 指向旧 Store digest 的 symlink/junction；
- 基于旧 Package + 旧 routing transform 的 managed copy；
- 当前 graph 已删除的旧 transitive Package projection；
- 被用户手工修改/替换后的普通目录或链接。

Marker target-id/generation 本身不足以区分这些情况。若仅凭身份相同就覆盖旧路径，会把 foreign/user-modified bytes 当成 Skiloom-owned，违反 fail-closed。

## 决定

### 1. Writer 升级到 `SKILOOM-STATE-V2`

官方 writer 从本 ADR 起生成：

```toml
format = "SKILOOM-STATE-V2"
```

Parser 必须继续接受合法 `SKILOOM-STATE-V1`。

V2 保留 V1 的：

```text
target-id
generation
requirements
projection-overrides
detached
```

并新增：

```text
[[managed]]
```

### 2. `[[managed]]` 只保存 ownership/materialization proof

每个 accepted managed projection 保存一条：

```toml
[[managed]]
package = "owner/repo/package"
activation-name = "package"
materialization = "symlink"
baseline-package-root = "."
baseline-content-digest = "sha256:..."
```

对于 transformed managed copy：

```toml
[[managed]]
package = "owner/repo/package"
activation-name = "package-local"
materialization = "copy"
baseline-package-root = "skills/package"
baseline-content-digest = "sha256:..."
baseline-transform-json = "{...canonical json...}"
```

字段：

- `package`：canonical Package Coordinate；
- `activation-name`：该副本最后同步 generation 时的实际 projection name；
- `materialization`：`symlink | junction | copy`；
- `baseline-package-root`：该 managed projection 对应 Package Root；
- `baseline-content-digest`：该 managed projection 对应 immutable Package Snapshot digest；
- `baseline-transform-json`：仅 transformed `copy` 需要；保存 canonical transform JSON。无 transform 时必须省略。

同一 Package 最多一条 `[[managed]]`。

### 3. Managed baseline 不是 source/resolver lock

V2 managed baseline **不得**保存：

- Release version / actual tag；
- Git requested ref；
- exact commit；
- repository-wide discovered graph；
- dependency edges；
- source authorization；
- resolver ordering / candidate facts。

它只回答一个问题：

> 这个 lagging Target path 是否仍精确等于 Skiloom 当时最后写下的 managed projection？

因此：

- DB-loss recovery 继续根据 requirements 重新解析；
- managed baseline 不决定恢复后的 source/version；
- Candidate source authority 不读取 `[[managed]]`；
- marker 仍不是 exact dependency Lock。

### 4. Lagging-copy sync 使用 baseline 证明旧 ownership

当 Registry generation 大于 copy marker generation：

1. 读取 V2 marker；
2. 根据 `[[managed]]` + immutable Package Store 重建旧 managed projection 期望；
3. 每条 live managed path 必须与旧 baseline 精确一致；
4. Detached Override 继续使用现有 detached baseline，不读写 user-owned bytes；
5. 以验证后的旧 projection set 作为 current ownership，和 Registry 当前 accepted TargetPlan 做正常 preflight；
6. 当前 graph 已删除的旧 managed projection可以安全删除，因为旧 baseline 已证明 ownership；
7. 当前 graph 新增 projection 只在目标位置 absent/safe 时物化；
8. reconcile 成功后写当前 generation 的 V2 marker。

若旧 Store entry 缺失/损坏、managed copy 与 baseline 不一致、目标位置存在 foreign bytes，则 fail closed。

`sync` 不为了验证旧 baseline 去重新获取旧 source；V2 marker没有旧 source facts，这一点是故意的。

### 5. V1 compatibility

合法 V1 marker 继续支持：

- DB-loss recovery；
- current-generation copy 的 exact verification / location registration；
- 普通 marker repair。

对于 **lagging V1 copy**：

- 若需要验证任何 managed projection，缺少 durable managed baseline，必须 fail closed，并报告 managed baseline required；
- 不允许根据 target-id、activation name 或“看起来像 Store link”猜测完整旧 ownership；
- 纯 detached/空 managed projection 的 lagging状态可以继续依赖现有 detached baseline处理。

成功同步到 current state 后统一写 V2 marker，因此现存副本会自然升级。

### 6. `target_locations` 是 generation-neutral machine observation

本机 Registry 的 `target_locations` 继续表示本机见过的 Target copy path。

location observation：

- 必须持有 `operation.lock`；
- 不递增 Target Generation；
- path 已属于其他 target-id 时 fail closed；
- `observed_generation` 不得高于 Registry current generation；
- current-generation copy 验证成功后直接记录 current generation；
- lagging copy 可在旧 ownership preflight 成功后记录 marker generation；
- 只有 reconcile 完成后才把该 path 的 `observed_generation` 提升到 Registry current generation。

### 7. Forget / Detached safety

- `forget` 后该 Package 不再存在于 V2 `[[managed]]` / `[[detached]]`；现存 user path 后续不得被 stale-sync 重新采纳。
- Detached Override 永远只使用 detached baseline；V2 managed baseline不覆盖或解释 user-owned bytes。

## 结果

V2 marker 增加的是**managed ownership proof**，不是 source lock。

它使 lagging Target copy 的 one-way sync 在 graph change、removed projection、transformed copy 场景下具有可验证旧 ownership，同时保持：

- DB-loss recovery re-resolves；
- Registry 是日常 exact-state authority；
- marker identity alone 不授权覆盖；
- foreign/user-modified bytes fail closed；
- v1 marker backward-readable。
