# 排查报告：后台 agent "无声消失" + `codex exec --cd` 不生效（2026-06-11）

> 写给「在本仓新开窗口实现修复」的会话。问题、根因、证据、修法、已落地的临时缓解、验证计划全在下面。
> 调查来自 hunter 四仓重构会话（大量 codex-rescue / opus-reviewer 后台 agent + codex `task` 实现/评审）。
> 基线：`stable` 分支，版本 pin `100.0.1`。涉及 `8be4ab3 #361 harden Codex turn lifecycle`。

---

## 问题 1：长 codex turn 被 watchdog 误弃 → 后台 agent "无声消失"

### 症状
- 派出 codex-rescue / opus-reviewer 后台 agent 后，部分长任务**无完成通知就消失**。
- `TaskStop` / `TaskOutput` 报 `No task found`，而进程退出时 harness 又报它们 `was running when process exited`（两套注册表不一致）。
- 该现象在电脑重启**之前**就出现，非重启所致。

### 根因（坐实）
`plugins/codex/scripts/lib/codex.mjs` 的 per-turn watchdog（#361 引入）阈值对长 codex xhigh 任务太短：

- `CEILING_MS = resolveTimeoutMs("CODEX_COMPANION_TURN_TIMEOUT_MS", 1_800_000)` → 默认 **30 min**（`lib/codex.mjs:588`）：单 turn 绝对上限，超时 `{ turnAbandoned: true }`（:625-627）。
- `STALL_MS = resolveTimeoutMs("CODEX_COMPANION_TURN_STALL_MS", 600_000)` → 默认 **10 min**（`lib/codex.mjs:589`）：无任何 inbound 活动即判 stalled → `{ turnAbandoned: true }`（:640-642）。
- 触发后 `interruptTurnBestEffort`（:556）中断 turn → 调用方看到 turn 失败/消失。

长 codex 实现/评审任务很容易撞线：

> **实证**：本会话 vault Stage 3 exec7702 域聚合（gpt-5.3-codex-spark, xhigh）跑了 **28 min**，离 30 min ceiling **仅剩 2 min**；任务再大一点必被 abandon。大文件迁移 / 长推理阶段也可能 >10 min 无 inbound 事件而撞 STALL。

注：`app-server-broker.mjs:90` 的 `CODEX_COMPANION_BROKER_IDLE_MS`（默认 30 min）只在**无 client 连接**时收割空闲 broker（`armIdle` 仅在 idle 时 arm），**不杀活跃 job** → 已排除为活跃任务消失的直接原因。但见下方 #355。

### 已落地的临时缓解（config，未动本仓代码）
`~/.claude/settings.json` 已加 `env`，把三个阈值抬高（**下个 Claude 会话生效**）：
```json
"env": {
  "CODEX_COMPANION_TURN_TIMEOUT_MS": "5400000",   // 90 min
  "CODEX_COMPANION_TURN_STALL_MS":   "1200000",   // 20 min
  "CODEX_COMPANION_BROKER_IDLE_MS":  "3600000"    // 60 min
}
```
这正是插件作者预留的逃生口（报错文案就写 "raise CODEX_COMPANION_TURN_TIMEOUT_MS for long turns"）。但 config 只是缓解——默认值仍坑后人。

### 建议的正式修法（本仓，需双审——属 turn-lifecycle critical path）
按可信度/工作量排序，任选或组合：
1. **抬高默认值**（最小改动）：CEILING 默认 30→60/90 min，STALL 默认 10→20 min。`lib/codex.mjs:588-589`。代价：真 hung 任务检测变慢——可接受（STALL 仍会兜底）。
2. **STALL 把"codex 正在工作"计为活动**（更对）：当前 STALL 只看 inbound RPC 静默。codex 长推理/大写盘期间可能无事件但其实在干活。可在收到 `turn/started`、工具调用、token 流等任意 codex 侧"仍在推进"的信号时刷新 `lastActivity`（:634-646 的 stall 计时器读 `lastActivity`），区分"真静默卡死"与"长任务安静工作"。
3. **#355 background-job × turn-lifecycle 交互**（#361 的 dual-audit 自己标注"noted, not merged"）：后台 job（detached / `--background`）的 turn 生命周期管理需专门处理——避免父 turn 结束/idle 时把仍在跑的后台 codex turn 误判 abandoned 或随 broker 收割。这是"无声消失 + 注册表不一致"最可能的剩余根因，**优先查 #355**。

---

## 问题 2：`codex exec --cd <path>` 不生效 —— 改动落主 checkout 而非指定 worktree

### 症状
派 codex 在隔离 git worktree 里实现，但改动出现在该仓的**主 checkout 工作树**（on main，未提交），或 `/tmp/<x>-edit` clone，**不是**指定的 `.worktrees/<repo>-x`。多仓多次复现（matrix2/chain/swap/vault Stage3 各有不同落点）。

### 根因
- companion `task` **支持** `-C/--cwd`（`codex-companion.mjs:142` 的 `C:"cwd"` 别名；`resolveCommandCwd`（:148-149）= `options.cwd ? resolve(cwd, options.cwd) : process.cwd()`），cwd 经 `buildThreadParams`（`lib/codex.mjs:56-58`）传进 codex `thread/start`。
- **但**：缺省回退 `process.cwd()`；而 codex-rescue 子代理用的是 `codex exec --cd <path>` 写法 / 未把 per-task cwd 映射到 companion 的 `-C` → 实际用了子代理进程的 cwd（= 仓主 checkout 或 hunter 根）→ codex 在那里写盘。
- `/tmp clone` 落点则疑似 codex app-server 对 worktree 的 workspace-write 沙箱解析行为（worktree → git common-dir 或临时副本）；需在能跑 codex 的环境实测确认。

### 建议修法
1. **codex-rescue agent 文档 / runtime skill**（`plugins/codex/agents/codex-rescue.md`、`plugins/codex/skills/codex-cli-runtime/SKILL.md`）写明：要在某目录跑必须传 companion 的 `-C/--cwd <abs-path>`（不是 `codex exec --cd`），或先 `cd` 进目标目录再调；并说明 worktree 下 workspace-write 的落点行为。
2. 可选：companion `task` 在 worktree 场景下校验/警告 cwd 解析结果，避免静默落错地方。
3. 实测确认 codex app-server 对 git worktree 的 workspace 解析（是否解析到 common-dir / 是否 temp clone），据此决定是否需要在 broker `connect(cwd)` 侧规范化。

---

## 验证计划（修完后）
- 复现长 turn：用 fake-codex fixture 模拟 >30 min（或临时调小阈值）+ >10 min 静默，断言任务**不被误弃**（修法 1/2）；保留对真 hung（无任何推进信号）仍能 abandon 的测试。
- 后台 job：起一个 `--background` codex turn，让父 turn 结束/idle，断言后台 turn 不被收割、完成后有通知、`TaskOutput`/`TaskStop` 注册表一致（修法 3 / #355）。
- `--cd`：在一个 git worktree 里跑 companion `task -C <worktree>`，断言改动落 worktree 而非主 checkout。
- 全套 `npm test`（基线 98/98）绿；turn-lifecycle 改动按本仓规矩**双审（Opus + Codex gpt-5.5 xhigh）**。

## 参考（本仓 file:line）
- `plugins/codex/scripts/lib/codex.mjs`：`:556` interruptTurnBestEffort、`:588` CEILING、`:589` STALL、`:616-656` turnAbandoned 判定、`:56-58` buildThreadParams(cwd)、`:148-149` resolveCommandCwd。
- `plugins/codex/scripts/app-server-broker.mjs`：`:68` broker cwd、`:90` IDLE_MS。
- 相关 PR：`8be4ab3 #361`（turn lifecycle，dual-audit 已标 #355 未合并）、`#346`（codex-rescue reliability pass，HOLD 未合并）。

---

## 处理记录（2026-06-11，本仓修复会话）

**已修复并双审**（详见 `CHANGELOG-FORK.md`）：

- 问题 1：watchdog 默认值 CEILING 30→90 min、STALL 10→20 min；新增 in-flight 工作追踪（未完成 item / 活跃 subagent turn / 待定 collaboration 期间纯静默不判 stall，ceiling 兜底）。修法 1+2 落地。
- 问题 2 真根因比报告猜测更具体：`--cd` 不是 companion 旗标，被 `parseArgs` **静默吞进 prompt 文本**（`args.mjs` 未知长选项落 positional），codex 因此跑在调用方 cwd。修复：`--cd`→`--cwd` 别名、启动类命令严格校验目录存在、task 输出回显 workspace root、agent/skill 文档补 `-C` 路由契约与 `--` 逃生门。
- 问题 1 修法 3（#355）调查结论：broker idle 收割仅在无 client 连接时触发（有 socket 即重置计时），**不会杀活跃后台 job**；SessionEnd 清理本会话 job 属设计行为；`TaskStop`/`TaskOutput` 注册表不一致为 harness 侧问题，本仓无法修复。无需为 #355 改代码。
- `/tmp/<x>-edit` clone 落点（codex app-server 对 worktree 的 workspace-write 解析）仍未实测确认——多半是 codex 收到含 "--cd /path" 文本的 prompt 后自行 copy 到 /tmp 所致；待修复版部署后在真实 worktree 任务中观察。
