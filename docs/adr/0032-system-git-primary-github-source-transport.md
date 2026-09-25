# ADR 0032：GitHub repository 内容优先使用 system Git transport

- 状态：Accepted
- 日期：2026-09-25
- 对应执行票：#152 `Use system Git as the primary GitHub source transport`
- 修订：ADR 0029 的 GitHub credential 适用范围

## 背景

Skiloom v0 已经把 `github-release` 与 explicit `git` 建成不同 source kind，并把 accepted source identity 固定为 canonical repository coordinate、source-kind-specific facts、exact commit 与 Package Content Digest。

现有官方实现最初把 GitHub repository verification、ref/tag resolution、commit/tree/blob acquisition 全部放在 GitHub REST adapter 上。这带来两个与产品语义无关的问题：

1. public anonymous GitHub REST primary rate limit 很低，共享出口 IP 很容易在 Skiloom 自身几乎没有请求时已经耗尽；
2. 用户已经配置好的 Git/SSH access（包括 private repository、ssh-agent、`~/.ssh/config`、hardware-backed key）无法被普通 Git source acquisition 使用，反而要求额外的 GitHub API token。

这些限制来自 transport 选择，不来自 Skiloom 的 source identity、resolver 或 trust model。Git repository 自身已经能权威提供 ref/tag、exact commit、tree 与 blob facts；GitHub REST 只应保留 GitHub 平台特有的 metadata 职责。

## 决定

### 1. Git facts 与 GitHub platform metadata 分离

以下事实属于 Git repository transport：

- explicit Git ref -> exact commit；
- Release actual tag -> exact commit；
- exact commit tree enumeration；
- blob content acquisition；
- Git file mode / symlink facts。

以下事实仍可属于 GitHub API metadata transport：

- repository-scoped GitHub metadata / redirect detection where that product path requires it；
- published Release listing（包括 `draft` visibility）；
- GitHub `immutable` provenance signal；
- GitHub API rate-limit facts。

source kind 不因为 transport 改变。Git transport 与 REST transport 不是新的 source kind。

### 2. system Git 是 repository-content 的 primary transport

官方 Node control plane 可以直接启动用户机器上的 system `git` executable。

实现约束：

- Node 使用 direct spawn，不经 shell；
- acquisition 使用 temporary/bare Git object database，不需要 working-tree checkout；
- 不执行 repository hooks、package scripts 或 repository code；
- Git object/tree/blob 必须重新进入现有 repository discovery、Package snapshot 与 digest 验证；
- Git executable 缺失或 transport 失败必须返回 structured error，不能挂起等待交互输入。

#152 只建立 transport seam。#153、#154、#155 分别负责把 explicit Git、GitHub Release content acquisition、accepted exact-state maintenance 迁移到该 seam。

### 3. GitHub remote 顺序固定为 SSH first、public HTTPS fallback

对 canonical `owner/repo`，默认候选顺序为：

```text
git@github.com:owner/repo.git
https://github.com/owner/repo.git
```

SSH 失败后才尝试 Git HTTPS。

v0 的 HTTPS fallback 只作为 public repository fallback，不由 Skiloom 主动读取 Git credential helper。Private repository 的首选路径是用户已经配置好的 Git/SSH access；GitHub API token 仍可用于需要 GitHub API metadata 的路径。

### 4. Git/SSH credential 由 Git/SSH 自己拥有

允许 system Git / OpenSSH 使用用户已有的：

- `~/.ssh/config`；
- ssh-agent；
- SSH key / hardware-backed key；
- Git/OpenSSH 自身的 host routing（例如用户配置的 GitHub SSH-over-443）。

Skiloom MUST NOT：

- 读取、复制、解析、记录或持久化 SSH private key；
- 枚举或导出 ssh-agent credential material；
- 调用 `gh auth token`；
- 读取 `gh auth` 持久登录态；
- 主动读取 Git credential helper secret；
- 把任何 ambient Git/SSH credential 写入 Registry、Store/cache identity、marker、export、JSON/human output 或日志。

“Git/SSH 子进程自行使用用户配置”不等于“Skiloom 读取 credential”。

### 5. Git transport 必须 non-interactive

Skiloom 启动 Git 时关闭 terminal credential prompt。SSH acquisition 使用 batch semantics；需要首次 host-key confirmation、password/passphrase terminal prompt 等交互时，本次 transport 必须失败并返回 structured error，而不是让 Agent/CI 挂起。

用户可以在 Skiloom 之外预先配置 known_hosts、ssh-agent、`~/.ssh/config` 或其它正常 Git/SSH 环境。

### 6. ADR 0029 只定义 GitHub API credential discovery

```text
GH_TOKEN
> GITHUB_TOKEN
> anonymous
```

继续有效，但只属于 GitHub API metadata transport。

这些 token 不是 Git repository source identity，也不用于替代用户的 SSH key。Skiloom 仍不增加 `--token` / `--credential`、credential store/profile 或 `gh auth` secret extraction。

### 7. Accepted identity 与 exact verification 不变

无论 repository bytes 经 REST、system Git 或 source cache 获得：

- accepted source identity 不记录 transport kind；
- exact commit 必须存在；
- Package Content Digest 必须重新计算；
- 同一 Target / repository 的 whole-target resolution 仍只能绑定一个 exact source snapshot；
- `github-release` 与 `git` 不因为 transport failure 静默互相 fallback。

## 测试要求

至少覆盖：

1. GitHub remote candidate 顺序是 SSH -> HTTPS；
2. real system Git 可以从临时 repository/ref 得到 exact commit；
3. raw Git tree/file modes 能形成现有 canonical repository snapshot；
4. 第一个 Git remote 失败时按顺序尝试下一个候选；
5. system Git 缺失返回 structured、secret-safe error；
6. Git 子进程不经 shell且禁用 terminal credential prompt；
7. 后续 source migration ticket必须证明 Git 成功路径不再调用对应 REST ref/tree/blob endpoint。

## 结果

Skiloom 的 GitHub source 从“GitHub REST 承担 Git repository 内容 transport”转为“Git transport 提供 Git facts，GitHub API 只提供 GitHub-specific metadata”。这减少匿名 REST quota 压力，并允许用户现有 Git/SSH access 自然服务 private repository，同时保持 Skiloom 不拥有、不复制、不持久化 credential。
