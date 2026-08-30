# @deepseek-ai/dsh-goal-round-loop-detector

English | [中文](README.zh.md)

A policy guard for goal continuation rounds — the deterministic sibling of
[repeat-tool-reminder](../repeat-tool-reminder/README.md). Where that guard only
*reminds* the model about repeated tool calls, this guard *stops* the goal: when
one agent's consecutive goal rounds keep emitting the same (or nearly the same)
output, the automatic continuation is terminated — the goal is disarmed, or,
with `action: block`, durably blocked with the stable reason code
`goal-round-loop`. It is model-independent: a looping model that never declares
`complete` or `blocked` cannot keep the rounds going.

A goal round is the turn entered for a round prompt (the `user/message` whose
source is `kind: 'goal'` with a positive `round`). When that turn completes,
the concatenated assistant text of the turn is the round's output. Consecutive
outputs of the same goal (and goal revision) that are identical, or whose
character-bigram Dice similarity is at or above `similarity`, extend a streak;
at `repeats` consecutive matching rounds the stop fires. This covers the loop
that slips past every other built-in stop: rounds that finish *cleanly* but
never make progress because each one re-emits the same status text. The round
cap (`maxGoalRounds`) and the driver's failure paths (`round-limit`,
`queue-failed`, abort, max-tokens) remain independent stops.

## Configuration

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

Misconfiguration fails loud at plugin load (non-integer or below-2 `repeats`,
`similarity` outside [0, 1], negative `minChars`, `previewChars` below 1),
mirroring the repeat-tool-reminder's fail-loud contract.

## 语义 / Semantics

- **Streaks are per agent, keyed by goal id and goal revision.** Any goal
  lifecycle change (pause/resume/complete/block/edit) bumps the revision, which
  the round prompt carries — a resumed goal therefore re-arms detection with a
  fresh streak and can be stopped again after another `repeats` identical
  rounds.
- **Only completed rounds count.** Aborted, max-tokens, error, and interrupted
  turns are skipped without touching the streak: incomplete output is not
  evidence of repetition.
- **Context changes reset the streak.** A human `user` prompt — or a round-0
  goal seed — between rounds resets it, mirroring the repeat-tool-reminder's
  interjection rule. Plugin-sourced context (injected notices) is transparent:
  it neither counts nor resets.
- **Different output resets the streak to one** — forward progress re-arms the
  full `repeats` budget.
- **The stop is deferred one microtask** out of the `turn/end` dispatch: the
  `block` action commits a `goal/change` event on the same session, and a
  nested append during event dispatch is not re-entrancy-safe.

### Action

- `disarm` (default): removes the process-local continuation authority; the
  durable phase stays `active`. The human can resume — or clear — the goal.
  This is the same stop the goal-round-driver applies on abort and max-tokens.
- `block`: transitions the goal to the durable `blocked` phase with the reason
  `goal-round-loop` (plus a human-readable message) and disarms it, following
  the driver's own `round-limit` precedent for policy-driven stops. The goal
  must be resumed explicitly.

The stop is logged with the agent, goal id, round number, streak length, and a
`previewChars`-bounded quote of the repeated output.

## 与现有停止机制的关系 / Relation to existing stops

| Stop | Trigger | Owner |
|---|---|---|
| `maxGoalRounds` cap | round budget exhausted | goal-round-driver (`round-limit`) |
| abort / max-tokens / agent error | failed turn | goal-round-driver (disarm / pause) |
| model `complete` / `blocked` | model judgment | tool-goal |
| **this guard** | N consecutive identical round outputs | goal-round-loop-detector |

The guard injects `agents` and `goals` and listens on `session/event` only; it
registers no tools, no system-prompt section, and no events of its own.
