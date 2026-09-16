# ADR 0014：Class R 使用 Cargo-style requirement 与 deterministic highest-first backtracking

- 状态：Partially Superseded by ADR 0018
- 日期：2026-09-14
- 当前说明：Cargo-style 版本要求、SemVer 候选顺序、确定性回溯、cycle 合法与旧状态不影响候选优先级等解析规则继续有效；Class R、Project Intent、Lock 与 conformance fixture 语义已退役。现行规则见 `docs/design/skiloom-v0-product-contract.md`。

## 背景

ADR 0005 已固定 GitHub Release version 是 repository-level SemVer；ADR 0011 已固定 Project Intent 与 Confirmed Resolution 分离，普通 replay 不重新求解；ADR 0012 又要求 Class R 在固定 source fixtures 上产生可重复结果。

剩余问题包括：SemVer 本身没有 dependency range grammar、多个 repository constraint 如何交集、prerelease 与 candidate ordering、version-dependent Manifest 是否 backtrack、旧 Lock 是否影响 update、cycle 是否非法，以及 conflict facts 如何跨实现稳定。

调研见 [`../research/semver-requirement-grammar-2026-09.md`](../research/semver-requirement-grammar-2026-09.md)。Cargo 提供 caret/tilde/wildcard/comparison/comma-intersection 与明确 prerelease语义，覆盖当前需求且比 npm `||`/hyphen/X-range grammar 更小。

## 决定

### Release Version Requirement v1

- 使用 Cargo Version Requirement semantics profile；
- SemVer version precedence 按 SemVer 2.0.0；
- 支持 default/caret/tilde/wildcard/comparison/comma-intersection；
- v1 不支持 `||` union、npm hyphen range 或 whitespace-as-AND；
- prerelease 采用 Cargo opt-in semantics；
- build metadata 可出现在 requirement input，但 matching/canonical requirement忽略它；
- Lock 中 top-level Release requirement 写 parser-defined canonical form。

### Candidate selection

- source binding始终 repository-scoped；
- explicit Git Project Intent覆盖该 repository 的 Release selection；同 repository transitive Release range仍需合法 parse，但不参与 Git commit selection；
- Release candidates按 SemVer precedence降序；
- `v1.2.3` / `1.2.3` 这种同 normalized version重复继续 fail closed；
- 只差 build metadata的不同 Release具有相同 precedence，resolver 不用 tag/date/API order发明优先级；search 到达该 tie 时返回 `AmbiguousReleasePrecedence`。

### Complete-solution search

v0 允许 backtracking，因为较高 Release 的 version-dependent Manifest可能使 dependency closure 无解，而较低 Release可能形成完整解。

Canonical search：

1. top-level input、Package expansion、dependency edge都按 canonical coordinate UTF-8 bytes处理；
2. propagation到 fixed point；
3. unresolved Release repository选择 coordinate最小者；
4. 该 repository候选按 SemVer precedence从高到低；
5. candidate branch失败则回退并尝试下一版本；
6. 第一个 complete solution即规范结果；
7. 旧 Confirmed Resolution不参与 candidate preference，只作为 diff/acceptance baseline。

future selective update若要保持非目标版本，必须通过显式 solver input/exact constraints表达，不能使用隐藏的“prefer locked” heuristic。

### Dependency cycles

Skill dependency cycle本身合法。Skiloom没有 build/link phase；只要 source/version constraints可满足，每个 exact Package只需 materialize一次。因此 resolver保存 cycle edges并用 visited/expanded state避免无限递归，不再返回 `DependencyCycle`。

### Structured failure

Class R 固定 machine-readable category与最小 conflict facts，包括 invalid requirement、unsatisfiable repository constraints、normalized version ambiguity、equal-precedence ambiguity与 candidate-exhausted graph failure；human-readable wording不是 Core。

完整算法与 fixture要求见 [`../design/resolver-conformance.md`](../design/resolver-conformance.md)。

## 结果

- `^1.4` 等现有设计示例获得精确、既有生态可解释的语义；
- Class R 不再依赖某个 language library、hash-map order、GitHub API return order或 previous Lock heuristic；
- global solver可以回退到较低 compatible Release，但只能按规范 branch order发生；
- ordinary replay仍完全不调用 resolver，因此 highest-first只影响 initial resolution / explicit re-resolution；
- cycle不再因为实现便利被人为禁止；真正冲突是无法满足的 source/version constraints；
- Host Observation software version grammar与 Class R彻底解耦。
