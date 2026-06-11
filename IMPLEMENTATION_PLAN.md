# 私有自用 fork + 自维护稳定版 codex 插件 — 实施计划

## 背景与决策

**目标**:fork `openai/codex-plugin-cc`,自维护一个稳定版,解决官方停摆(main 最后一次 merge 2026-04-18,距今约 7 周)导致的「卡死 / 无响应」,并主动修一个现存安全漏洞。

**双审结论(Opus 4.8 + Codex gpt-5.5 xhigh,均 high 置信)**:推荐 fork 自维护。基线安全干净:

- **零运行时依赖**(`dependencies: {}`)→ 无 npm 供应链面(不存在 litellm 式 transitive 投毒)
- 核心 ~5,100 行 `.mjs`,4 个脚本,**可完整审计**
- **无对外网络外联**:所有 `net.createConnection` 是本地 Unix socket(broker IPC),核心代码无 `http/https/fetch`
- **无 shell 注入**:`spawn` 全用数组参数 + `shell:false`(非 Windows);无 `exec/execSync/eval/new Function/base64 -d/curl|sh`
- **CI 安全**:workflow 用 `on: pull_request`(fork PR 拿不到 secrets),actions 全 pin commit SHA

**唯一真实风险** = merge 时夹带恶意 diff → 靠每个 PR 的 diff 审计拦截(见下方 Checklist)。

**外加现存漏洞(本计划 Stage 2 主动修,不依赖任何 PR)**:`plugins/codex/scripts/lib/git.mjs` 的 `formatUntrackedFile`(:196-221)用 `fs.statSync`(:200)/ `fs.readFileSync`(:213)读 untracked 文件,**跟随 symlink**。攻击链:clone 恶意 repo → 内含 untracked 软链 `notes.txt → ~/.ssh/id_rsa`(或 `~/.codex/auth.json` / `.env`)→ 对其跑 `/codex:review` → 私钥/token 被读进 review context 发给 Codex。size 上限与二进制过滤拦不住小文本密钥。

---

## 私有 fork 的正确姿势(GitHub 限制)

GitHub **不允许**把 public repo 的 fork 设为 private。私有自用要用 **mirror 方式**:

1. GitHub 新建一个 **private** repo(如 `<user>/codex-plugin-cc-stable`)
2. 本地把现有 `origin`(openai)改名为 `upstream`,新增 `origin` 指向私有 repo
3. push;之后用 `git fetch upstream && git rebase upstream/main` 跟官方同步

---

## 优先合并清单(根因优先级 × 审计成本)

| 批次 | PR | 规模 | 作用 | 审计难度 |
|---|---|---|---|---|
| **第一批**(治 ~80% 卡死) | #302 | +153/−1 | `request()` wall-clock timeout(**总根因**) | 低 |
| | #312 | +122/−2 | per-turn watchdog + exit 124 | 低 |
| | #300 | +60/−7 | broker shutdown hang | 低 |
| **第二批**(按需加固) | #361 | +409/−14 | bound stalls / idle broker shutdown | 中 |
| | #343 | +549/−9 | stale broker cleanup | 中 |
| | #294 | +41/−2 | auth-retry hang | 低 |
| | #355 | +168/−5 | jobs alive across SessionEnd | 低 |
| | #346 | +2515/−82 | worker-lifecycle hardening | **高**(拆审或暂缓) |

> 第一批三项合计仅 ~335 行,均为根因修复,预计消除大部分卡死,ROI 最高。
> **合并方式**:不直接 merge 陌生分支(避免引入隐藏 commit)。流程:`gh pr diff <N>` 取净 diff → Opus + Codex 双审过 Checklist → 通过则 `git apply` 落成你自己的干净 commit(co-author 原作者 + Claude)。

---

## 安全审计 Checklist(每个 PR 必过,命中即打回)

- [ ] 新增 `child_process` / `exec` / `shell:true` / 字符串拼接命令
- [ ] 新增网络:`fetch` / `http(s)` / `net.connect` / 外部 URL / webhook / 遥测
- [ ] 解释执行:`eval` / `new Function` / 动态 `import()` 非常量 / base64 解码后执行
- [ ] 新增 runtime 依赖(默认高危:必须解释必要性 + 锁版本 + 查 transitive graph)
- [ ] 凭据:读 `~/.codex` / `auth.json` / `OPENAI_API_KEY` / 批量打印上传 `process.env`
- [ ] 路径:用户输入进 `path.join/resolve` 读写,需限定 workspace/state/tmp;查 symlink / `..` / 绝对路径
- [ ] broker/session:socket / pid / log 路径处理不得删除任意路径
- [ ] 混淆迹象:压缩代码 / 长 base64 / 超大 diff / 改核心却无测试
- [ ] 必带测试:timeout / broker busy / shutdown / stale / background / auth fail / Windows shell 分支

---

## Stage 1: 私有 fork 基础设施
**Goal**: 建立 private mirror repo + upstream 同步关系,基线测试通过
**Success Criteria**:
- private repo 创建;`origin` 指向它,`upstream` 指向 `openai/codex-plugin-cc`
- 建 `stable` 工作分支(基于当前 `807e03a` / v1.0.4)
- `NOTICE` 或新建 `CHANGELOG-FORK.md` 标注:本 fork 基于 `openai/codex-plugin-cc @807e03a`,Apache-2.0 合规(保留 LICENSE/NOTICE)
**Tests**: `npm test`(现有 `tests/*.test.mjs` 全绿);`npm run build` 成功
**Status**: Complete(2026-06-07;origin=Jafee/codex-plugin-cc-stable,基线 807e03a)

## Stage 2: 主动修 symlink 漏洞(不依赖任何 PR)
**Goal**: `lib/git.mjs` 不再跟随指向 cwd 外的 symlink
**Success Criteria**:
- `formatUntrackedFile`(及相关 untracked 收集路径)改用 `fs.lstatSync` 检测软链;若为软链则 `fs.realpathSync` 校验解析后路径仍在 cwd 内,否则 skip 并标注 `(skipped: symlink outside workspace)`
- 不破坏正常 untracked 文本文件读取
**Tests**(扩充 `tests/git.test.mjs`):
- untracked 软链指向 cwd 外文件 → 被 skip,目标内容不出现在输出
- untracked 普通文本文件 → 正常读取
- untracked 软链指向 cwd 内文件 → 取保守策略(建议仍按相对路径处理或 skip,二选一并测试固化)
**Status**: Complete(487b54d + 138958e;详见 CHANGELOG-FORK)

## Stage 3: 第一批根因修复(#302, #312, #300)
**Goal**: 消除「卡死 / 无响应」的核心根因(request/captureTurn 永等 + broker shutdown hang)
**Success Criteria**:
- 三个 PR 各自 diff 通过双审 Checklist
- 各自以审计后的干净 commit 落地(co-author 原作者 + Claude)
- `request()`(`lib/app-server.mjs:85-97`)有 wall-clock timeout;captureTurn 有 watchdog;broker shutdown 不再无限阻塞
**Tests**:
- 每个 PR 自带测试合并并通过
- 回归:`npm test` 全绿、`npm run build` 成功
- 手动:模拟 app-server 不响应 → 验证超时/watchdog 退出而非永久卡住
**Status**: Complete(#302=18d3ee9、#300=357893b;#312 被 #361 取代不合入)

## Stage 4: 第二批加固(按需:#361, #343, #294, #355, #346)
**Goal**: 进一步加固 broker/worker 生命周期与 auth/session 边界
**Success Criteria**:
- 选定 PR 通过双审 + 干净落地 + 测试绿
- #346(2515 行)若审计成本过高 → 拆分或暂缓,并在 `CHANGELOG-FORK.md` 标注「未合并 + 原因」
**Tests**: 各 PR 测试 + 全量回归
**Status**: Complete(#361=8be4ab3 + 多轮加固;#294/#343/#355/#346 HOLD,理由见 CHANGELOG-FORK)

## Stage 5: 让稳定版实际生效 + 持续同步
**Goal**: 本地 Claude Code 实际用上 fork 的稳定版;固化同步与审计流程
**Success Criteria**:
- 勘察当前插件安装方式(`~/.claude/plugins/cache/openai-codex/codex/<version>/` 与 `.claude-plugin/marketplace.json`),把本地插件指向私有 fork 的 `stable`
- 实跑若干 `/codex:review`、`/codex:rescue` 任务,确认不再卡死
- 写 `MAINTAINING.md`:如何 `rebase upstream`、如何审计新 PR(引用本 Checklist)、tag 规范(如 `1.0.4-stable.N`)
**Tests**: 真实使用验证(review/rescue 各跑通、无 hang);记录前后对比
**Status**: Complete(本地 marketplace 指向 fork,版本 pin 100.0.x;MAINTAINING.md 未单独成文,流程暂以本文件 Checklist + CHANGELOG-FORK 为准)

---

## 风险与回滚
- 每个 stage 独立 commit,可单独 `revert`
- `stable` 与 upstream 同步用 `rebase`,冲突时优先保留官方语义
- 某修复引入回归 → `revert` 该 commit,不影响其他 stage
- **全程不引入 runtime 依赖**;**不放宽** CI 的 `pull_request` → `pull_request_target`
- 合并的是「经审计的代码变更」而非「陌生人的 git 历史」——每个 PR 都重落成自己的干净 commit
