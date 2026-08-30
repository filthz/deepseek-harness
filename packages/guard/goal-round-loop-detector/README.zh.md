# @deepseek-ai/dsh-goal-round-loop-detector

[English](README.md) | 中文

面向 goal 继续轮次的策略护栏 —— [repeat-tool-reminder](../repeat-tool-reminder/README.zh.md) 的确定性姊妹版。那个 guard 只会*提醒*模型重复的工具调用，而这个 guard 会*停止* goal：当某个 agent 的连续 goal 轮次不断输出相同（或几乎相同）的内容时，自动继续即被终止 —— goal 被 disarmed（解除武装），或在 `action: block` 时被持久地标记为 blocked（稳定原因代码 `goal-round-loop`）。它不依赖模型：一个从不声明 `complete` 或 `blocked` 的循环模型无法让轮次继续下去。

一个 goal 轮次是为轮次提示（source 为 `kind: 'goal'` 且 `round` 为正的 `user/message`）进入的 turn。该 turn 完成时，turn 内拼接后的助手文本即为该轮次的输出。同一 goal（同一 goal revision）的连续输出若相同、或其字符二元组（bigram）Dice 相似度不低于 `similarity`，则延长连续计数（streak）；当连续 `repeats` 个轮次匹配时触发停止。这覆盖了一种能溜过所有其他内建停止机制的循环：轮次*干净地*完成但从不取得进展，因为每一轮都重新输出同一段状态文本。轮次上限（`maxGoalRounds`）与 driver 的失败路径（`round-limit`、`queue-failed`、aborted、max-tokens）仍是各自独立的停止机制。

## 配置

```yaml
- id: goal-round-loop-detector
  name: '@deepseek-ai/dsh-goal-round-loop-detector'
  config:
    repeats: 3        # default; consecutive near-identical rounds that trigger the stop
    similarity: 0.9   # default; bigram Dice threshold, 1 = exact normalized match
    minChars: 32      # default; outputs shorter than this never count
    action: disarm    # 'disarm' (default) or 'block'
    previewChars: 200 # default; output quoted in the log line on a stop
```

错误配置在插件加载时快速失败（`repeats` 非整数或小于 2、`similarity` 超出 [0, 1]、`minChars` 为负、`previewChars` 小于 1），与 repeat-tool-reminder 的 fail-loud 约定一致。

## 语义

- **streak 按 agent 分键，键为 goal id 和 goal revision。** 任何 goal 生命周期变更（pause/resume/complete/block/edit）都会递增 revision，而轮次提示携带该 revision —— 因此 resume 后的 goal 以全新 streak 重新武装检测，可在再出现 `repeats` 个相同轮次后再次被停止。
- **只有完成的轮次才计数。** aborted、max-tokens、error 与 interrupted 的 turn 被跳过且不触碰 streak：不完整的输出不是重复的证据。
- **上下文变更重置 streak。** 轮次之间的人类 `user` 提示（或 round-0 的 goal seed）会重置它，与 repeat-tool-reminder 的中断规则一致。插件来源的上下文（注入的通知）是透明的：既不计数也不重置。
- **不同的输出将 streak 重置为一** —— 取得进展即重新获得完整的 `repeats` 预算。
- **停止动作被推迟一个微任务**（脱离 `turn/end` 派发）：`block` 动作会在同一 session 上提交 `goal/change` 事件，而事件派发期间的嵌套 append 不具备重入安全性。

### 动作

- `disarm`（默认）：移除进程内的继续权限；持久 phase 保持 `active`。人类可以 resume（或 clear）该 goal。这与 goal-round-driver 在 aborted 和 max-tokens 时应用的停止相同。
- `block`：将 goal 迁移到持久的 `blocked` phase，附带原因 `goal-round-loop`（及人类可读信息）并解除武装，沿袭 driver 自身 `round-limit` 先例（策略驱动的停止）。goal 必须被显式 resume。

每次停止都会记录 agent、goal id、轮次号、连续长度，以及一段 `previewChars` 截断的重复输出引用。

## 与现有停止机制的关系

| 停止 | 触发条件 | 归属 |
|---|---|---|
| `maxGoalRounds` 上限 | 轮次预算耗尽 | goal-round-driver（`round-limit`） |
| aborted / max-tokens / agent error | 失败的 turn | goal-round-driver（disarm / pause） |
| 模型 `complete` / `blocked` | 模型判断 | tool-goal |
| **本 guard** | N 个连续相同的轮次输出 | goal-round-loop-detector |

该 guard 注入 `agents` 与 `goals`，仅监听 `session/event`；不注册工具、系统提示段落或自有事件。
