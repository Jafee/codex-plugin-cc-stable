# 给 `status --wait` 的默认超时加环境变量入口

日期：2026-07-28 ｜ 分支：`feat/wait-timeout-env` ｜ 状态：设计中

## 背景与问题

`codex-companion.mjs status <job> --wait` 的默认超时是 240 秒（`plugins/codex/scripts/codex-companion.mjs:70` 的 `DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000`）。后台 codex 任务经常跑几十分钟，所以每次挂 watcher 都必须手写一遍 `--timeout-ms 7200000`；一旦忘写，watcher 会在 240 秒后带着 `waitTimedOut: true` 退出，看起来像任务结束了，实际上任务还在跑。

仓库里其他几个超时早就走环境变量了（`CODEX_COMPANION_TURN_TIMEOUT_MS`、`CODEX_COMPANION_TURN_STALL_MS`、`CODEX_COMPANION_BROKER_IDLE_MS`），唯独这个 wait 超时没有，只能靠每次手传。

## 方案

复用仓库已有的 `resolveTimeoutMs(envName, defaultMs)`（`plugins/codex/scripts/lib/app-server.mjs:45`，已 export，另外三个文件在用）。它的语义正好合用：环境变量没设、为空、非数字、负数一律回退到默认值，正数取 `min(值, MAX_TIMER_MS)`。

在 `codex-companion.mjs` 里 import 它（该文件目前还没 import `lib/app-server.mjs`），把 `waitForSingleJobSnapshot`（`codex-companion.mjs:354`）里的默认值替换掉：

```js
const timeoutMs = Math.max(0, Number(options.timeoutMs) ||
  resolveTimeoutMs("CODEX_COMPANION_STATUS_WAIT_TIMEOUT_MS", DEFAULT_STATUS_WAIT_TIMEOUT_MS));
```

优先级：显式 `--timeout-ms` > 环境变量 > 240000。显式参数的行为完全不变。

变量名沿用仓库的 `CODEX_COMPANION_*_TIMEOUT_MS` 命名惯例。

**测试**：照搬 `tests/runtime.test.mjs:1688` 那个现成的用例 —— 它造一个 `running` 状态的 job fixture，跑 `status task-live --wait --timeout-ms 25 --json`，断言 `waitTimedOut: true`。新用例用同一个 fixture，改成不传 `--timeout-ms`、用环境变量传 25，断言同样超时且返回的 `timeoutMs` 是 25。注意 `tests/helpers.mjs:15` 的 `run()` 把 `env` 整个替换而不是合并，所以要传 `{ ...process.env, CODEX_COMPANION_STATUS_WAIT_TIMEOUT_MS: "25" }`。

因为有现成的子进程测试模式，**不需要**把 `waitForSingleJobSnapshot` 抽成可导出的函数。

## 工作契约

- **Goal**：`CODEX_COMPANION_STATUS_WAIT_TIMEOUT_MS` 能覆盖 `status --wait` 的 240 秒默认超时，显式 `--timeout-ms` 优先级不变。
- **Verification**：在干净环境跑全量测试全绿，按 CHANGELOG-FORK.md 的回归门禁要求：
  `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID npm test`
  外加 `npm run build` 通过。新增用例必须出现在测试输出里。
- **Done**：上面两条命令通过，且新增用例在不设环境变量时不影响既有行为（既有的 12 个测试文件全部照常通过）。

## 范围契约

```ship-scope
base: 27ff515
max_files: 3
max_added_lines: 50
max_new_files: 0
allow_paths:
  - plugins/codex/scripts/codex-companion.mjs
  - tests/runtime.test.mjs
  - CHANGELOG-FORK.md
forbid_new_deps: true
```

校验命令：

```bash
python3 ~/.claude/skills/ship/scripts/budget_check.py \
  docs/designs/2026-07-28-status-wait-timeout-env.md --repo <worktree>
```

**明确不做的事**：

- 不给 `--poll-interval-ms` 也加环境变量（同类需求，但不是这次的目标）
- 不加取值上限校验、不加超限告警日志 —— `resolveTimeoutMs` 已经对非法值 fail-safe 回退
- 不抽取 `waitForSingleJobSnapshot`、不新增 lib 模块、不做任何重构
- 不改 README（一行 CHANGELOG-FORK 记录足够；README 更新如有必要走后续建议）
- 不引入任何依赖（fork 的硬性维护原则：零运行时依赖）

## 风险

低。环境变量没设时行为逐字节不变（`resolveTimeoutMs` 在 `raw === undefined` 时直接返回默认值）。回滚就是撤掉这个 commit。

唯一要留意的是优先级顺序写反 —— 如果环境变量盖过了显式 `--timeout-ms`，会破坏既有调用方，属于 blocking 级问题，测试必须覆盖这一条。

## 后续建议

（流程中攒下的非阻塞项，最后搬进 PR 描述的同名小节。）
