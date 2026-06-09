# Fork 维护说明 / CHANGELOG-FORK

本仓库是 [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 的**私有自维护 fork**(`stable` 分支),用于在官方维护停滞期间合入**经过 Opus + Codex 双重安全审计**的稳定性修复(主要解决「卡死 / 无响应」)。

## 来源与合规(Apache-2.0)

- **Upstream**: `openai/codex-plugin-cc`
- **Fork 基线**: `807e03ac9d5aa23bc395fdec8c3767500a86b3cf`(v1.0.4,2026-04-18,已逐字节核验等于官方 main tip)
- **许可证**: Apache-2.0(保留原 `LICENSE` 与 `NOTICE`)
- 本 fork 的所有修改在下方 Changelog 标注

## 维护原则(安全不变量,不可破坏)

- **零运行时依赖**:绝不引入任何 runtime dependency
- **无对外网络**:核心代码不新增 `fetch/http/net.connect` 到外部主机
- **无 shell 注入**:`spawn` 一律用数组参数,不拼接 shell 字符串
- **不放宽 CI**:保持 `on: pull_request`,绝不改成 `pull_request_target`
- **双审强制**:每个合入的 upstream PR 必须通过 Opus + Codex 双重安全审计(Verdict 一致 PASS 才合)
- **干净落地**:审计 PR 的净 diff 后,重落为本 fork 的干净 commit(co-author 原作者),不直接 merge 陌生人分支历史
- **回归门禁**:合入后 `npm test` 必须在干净环境(`env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID ...`)全绿

## Changelog

### [未发布] stable

**已合入**(均经 Opus + Codex 双重安全审计:9 条红线全清、0 安全发现):

- `docs`: 添加 fork 维护计划(`IMPLEMENTATION_PLAN.md`)与本说明 — `71e17e8`
- `security`: 修复 untracked 文件 symlink 逃逸导致的凭据泄露(`lib/git.mjs`,`realpathSync` 限定 workspace 内)— `487b54d`,边界测试/TOCTOU 标注 `138958e`。Opus 设计+验证,Codex 独立复审 NEEDS_DISCUSSION(**无安全阻断**;TOCTOU 残余需本机并发执行能力、在威胁模型外,已诚实标注)
- #300 `fix`: broker shutdown 加 wall-clock timeout,broker 接受连接却不回复时不再无限挂 — `357893b`
- #302 `feat`: JSON-RPC `request()` 加 per-request wall-clock timeout + turn idle timeout,根治「卡死/无响应」主根因(request 永久 pending)— `18d3ee9`
- #361 `feat`: 加固 Codex turn 生命周期 — 用 `Promise.race([work, ceiling, stall, exit])` + `interruptTurnBestEffort` 替换 #302 在 captureTurn 的 idle 机制(额外覆盖 pre-ACK start RPC hang/reject、abandoned turn 上游 interrupt 防重叠重试),保留 #302 的 app-server `request()` 超时;broker 闲置自杀(`CODEX_COMPANION_BROKER_IDLE_MS` 默认 30min)+ `onSocketGone` 孤儿 turn 自毁(根治 broker 进程泄漏)+ shutdown 先关 listener 再关 appClient;失败回传错误而非空响应(治「无响应」)— `8be4ab3`。**双审 Opus + Codex(gpt-5.5 xhigh)均 APPROVE**,9 红线全清、0 安全发现,3 个互相印证的 LOW 非阻断(onSocketGone `error+close` 双事件幂等但无专测、`CEILING_MS` 兜底路径无专测、#355 后台任务交互——#355 未合,非缺陷)。全套 98/98 干净环境绿
- `fix`(外部 review 跟进):加固 `connect()` 失败清理 + 统一 timeout env 解析 — `9ae3ce1`。**P2**:`connect()` 在 `initialize()` 失败时不再遗弃已 spawn 的 app-server / broker socket;清理做成**有界且健壮**——`Promise.race([close(), 2s cap])` 防无界挂、`close()` 把 SIGTERM 升级到 SIGKILL(守卫 `exitCode===null && signalCode===null`)、再 destroy 父侧 stdout/stderr 读流(切断后代继承 stdio fd 对父进程事件循环的牵制)。**P3**:turn/stall/broker-idle 的 `Number(x)||default` 统一为 `resolveTimeoutMs(env, default, {allowDisable})`——拒非有限/负数、上界 clamp 到 2³¹-1(防超大值被 Node 截成 1ms 立即触发)、保留 RPC 的 0=禁用语义。**双审 Opus + Codex(gpt-5.5 xhigh)历经 4 轮**:Codex 在 P2 第一版连抓 **3 个实测可复现的真 HIGH**(无界 close 挂 / 未 reap 子进程 stdio 句柄卡父进程 / 孙进程继承 fd 卡父进程),逐一修复且每个都配「拆掉即失败」的回归测试;两边终审均 **APPROVE**,9 红线全清。全套 105/105 干净环境绿。**教训:单审挡不住这类底层(Node 子进程 stdio 继承)缺陷,跨 LLM 多轮对抗是必要的**
- `fix`(push 前最终独立交叉终审):broker `shutdown()` 加有界 drain — `61a3c52`。终审用**全新无作者上下文的独立 Opus 审计员 + fresh Codex** 冷审完整 delta(`c7d071a..HEAD`)。Codex 抓到 `onSocketGone`/idle 自毁里 `await server.close()` **要等所有连接结束才回调**——若第二个 broker 客户端(同 cwd 并发会话)半开/卡住不回 FIN,`server.close()` 永不完成 → 永不关 upstream、永不退出,#361 的孤儿 turn 自毁失效(**HIGH**,我和上一轮双审都漏了、独立冷审才逮到)。修:`server.close()` 与 `SHUTDOWN_DRAIN_MS`(1s)定时器 race,到期 destroy 半开连接,shutdown 始终有界;idle 路径也对齐 `onSocketGone` 的 `.finally(()=>process.exit(0))`(防 shutdown reject 时漏退出)。补「半开 straggler + broker/shutdown → broker 仍有界退出」回归测试(拆掉即 8s 挂死)。**独立 Opus APPROVE(0 Critical/Important)、Codex REQUEST CHANGES(此 HIGH)——分歧按铁律保守裁决、主线显式裁定修复后重审**。全套 106/106 干净环境绿

**暂缓 / 不合入**:

- #312(per-turn watchdog):**已被 #361 取代(SUPERSEDED),永久弃用**。#312 的 watchdog 打不断卡住的 `startRequest()`,timer reject 一个无人 await 的 promise → unhandledRejection / exit 1(而非 PR 承诺的 exit 124)——Codex 在 Node v24.10.0 复现 HIGH 正确性缺陷;新测试也只覆盖错误对象形状、未测真实 timeout 行为。#361 用 `Promise.race`(从创建即观测所有 racer、包裹 start RPC、上游 interrupt)**正确实现了 #312 想做的事**,已于 `8be4ab3` 合入,故 #312 不再合入。
- #294 / #343 / #355:仍 **HOLD**(未变)。#294 Windows `cmd.exe` + baseRef 校验自带命令注入风险;#343 PowerShell 进程清理自带注入 + 误杀风险;#355 background job broker 保活属独立功能(非缺陷),#361 的 broker 闲置自杀与其**互补**(一个保活一个收尸),如未来重度依赖跨会话后台任务再单独评估合入。
- #346(codex-rescue reliability pass):**HOLD,暂不考虑合并**(用户 2026-06-09 决定:改动太大)。16 文件 / 3099 行,且是整批唯一引入**自动执行 PostToolUse hook** 的 PR(`codex-rescue-completion-hook.mjs`:Agent 工具用后注入"已完成/别空等"上下文)+ 后台 task-worker spawn + 测试用 `NODE_OPTIONS` preload。功能为 codex-rescue 完成信号 + worker 生命周期检测,属**可靠性打磨**而非根因修复——「卡死/无响应」主根因已被 #302+#361 覆盖,边际价值低;risk/reward 全批最差(最大改动 + 新增 auto-exec hook 攻击面)。快扫未见明显危险(hook 仅读 state 吐文本、spawn 用数组参数),但**未做 merge 级完整双审**。将来若"Claude 在 codex-rescue 已返回后仍空等/轮询"症状明显,再正经双审或只 cherry-pick 最小完成信号版。

**已知限制 / 未来加固候选**:

- **review context 仍会读入 workspace _内_ 的敏感 untracked 文件**:`487b54d` 的 symlink 修复只挡住了**逃逸到 workspace 外**;workspace 内的 untracked `.env` / `.git/config`(无论是否经 symlink)仍会进入发往 Codex 的 review context(外部 reviewer 第 3 条意见,既存问题、非本批引入)。故本 fork 的 symlink 修复**不应被理解为「防住一切凭据读入 review」**。未来加固方向:构建 untracked review context 时跳过 gitignored / 已知敏感模式(`.env`、`.git/` 等)文件。
- **`close()` 的 SIGKILL 只杀直接 app-server 子进程、不 reap 其后代**:若真实 codex app-server spawn 了继承其 stdio 的工具/MCP 子进程,SIGKILL 父进程后这些**孙进程可能继续存活**(占资源 / 改 workspace)。**既存问题、非本批引入**(close 一直只杀直接子);P2 的 stream-destroy 已解决「后代继承 fd 卡住父进程退出」(**卡死**),但未解决「后代继续运行」(**孤儿**)。Codex 终审 MEDIUM、独立 Opus 未判为问题。未来加固:POSIX 进程组强杀(`detached` spawn + `kill -pid`)——是独立的 spawn 行为改动,需自己一轮审计,不在本次 push 前扩大范围。
