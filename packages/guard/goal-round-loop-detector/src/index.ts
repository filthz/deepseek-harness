/**
 * Goal-round loop detector: a policy guard for goal continuation rounds.
 *
 * One goal round is the turn entered for a round prompt — the `user/message`
 * whose source is `kind: 'goal'` with a positive `round`. When that turn
 * completes, the concatenated assistant text of the turn is the round's
 * output. Consecutive outputs of the same goal (revision) that are identical
 * or near-identical (character-bigram Dice similarity at or above the
 * configured threshold) extend a streak; at the configured streak length the
 * guard stops the goal's automatic continuation — by default disarming it, or
 * durably blocking it with the stable reason code `goal-round-loop`.
 *
 * The stop is deterministic policy, not model advice: unlike
 * `repeat-tool-reminder` (advisory, tool-call chain only) this guard needs no
 * model cooperation and cannot be talked out of a stop. The round cap
 * (`maxGoalRounds`) and the driver's failure paths (`round-limit`,
 * `queue-failed`, abort, max-tokens) remain independent stops; this guard
 * covers the case that slips past all of them: a goal whose rounds finish
 * cleanly but never make progress because every round re-emits the same
 * status text.
 *
 * Chain semantics (per agent, keyed by goal id and goal revision):
 * - Only `turn/end { kind: 'completed' }` rounds contribute evidence. Aborted,
 *   max-tokens, error, and interrupted rounds are skipped without touching the
 *   streak: incomplete output is not evidence of repetition.
 * - A human `user` prompt (or a round-0 goal seed) between rounds changes the
 *   context and resets the streak, mirroring the repeat-tool-reminder's
 *   interjection rule. Plugin-sourced context is transparent: it neither
 *   counts nor resets.
 * - A different output resets the streak to one. Any goal lifecycle change
 *   (pause/resume/complete/block/edit) bumps the revision, which the round
 *   prompt carries, so a resumed goal re-arms detection with a fresh streak.
 * - Rounds whose normalized output is shorter than `minChars` are skipped
 *   without touching the streak: trivially short outputs are not meaningful
 *   repetition evidence.
 * @module @deepseek-ai/dsh-goal-round-loop-detector
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'goal-round-loop-detector'

/** Services the guard reads: the live agent registry and the goal service. */
export const inject = ['agents', 'goals']

/** Durable blocker code recorded when `action: 'block'` stops the goal. */
const BLOCK_CODE = 'goal-round-loop'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: a non-integer
 * `repeats` below 2, a `similarity` outside [0, 1], a negative `minChars`, or
 * a `previewChars` below 1 throws at plugin load, never a silent fall-back).
 */
export interface Config {
  /**
   * Consecutive near-identical goal rounds that trigger the stop (default 3).
   * The streak length counts rounds, including the first that established the
   * compared text: at the default, round 1 emits T, rounds 2 and 3 repeat it,
   * and the stop fires when round 3 completes.
   */
  repeats?: number
  /**
   * Minimum character-bigram Dice similarity for two outputs to count as
   * identical, 0..1 with 1 meaning exact normalized match (default 0.9).
   */
  similarity?: number
  /**
   * Minimum normalized round-output length in characters for a round to
   * participate in the streak; shorter outputs are skipped (default 32).
   */
  minChars?: number
  /**
   * Stop action (default 'disarm'). 'disarm' removes automatic continuation
   * authority while the durable phase stays `active`; 'block' transitions the
   * goal to the durable `blocked` phase with the `goal-round-loop` reason,
   * following the driver's own `round-limit` precedent.
   */
  action?: 'disarm' | 'block'
  /** Maximum characters of the repeated output quoted in log lines (default 200). */
  previewChars?: number
}

export const Config: z<Config> = z.object({
  repeats: z.number().default(3),
  similarity: z.number().default(0.9),
  minChars: z.number().default(32),
  action: z.union([z.const('disarm'), z.const('block')]).default('disarm'),
  previewChars: z.number().default(200),
})

/** Resolved, validated configuration. */
interface ResolvedConfig {
  readonly repeats: number
  readonly similarity: number
  readonly minChars: number
  readonly action: 'disarm' | 'block'
  readonly previewChars: number
}

/** The goal round currently in flight for one agent: its round prompt was admitted, its turn not yet closed. */
interface OpenRound {
  readonly goalId: string
  readonly revision: number
  readonly round: number
  texts: string[]
}

/** The completed-round output streak for one agent. */
interface Streak {
  readonly goalId: string
  readonly revision: number
  lastText: string
  /** Consecutive comparable rounds whose output matches `lastText`, including the round that set it. */
  count: number
  /** This streak already triggered the stop once; do not re-trigger for the same goal revision. */
  stopped: boolean
}

/**
 * Validate config fields the schema cannot express (integrality, ranges) and
 * fail loud on misconfiguration. The schema's `.default()` guarantees every
 * field is materialized after validation, so the input-side optionality is
 * cast away at the boundary (repeat-tool-reminder pattern).
 * @param config - validated config with schema defaults materialized.
 */
function validate(config: Config): ResolvedConfig {
  const repeats = config.repeats as number
  const similarity = config.similarity as number
  const minChars = config.minChars as number
  const action = config.action as 'disarm' | 'block'
  const previewChars = config.previewChars as number
  if (!Number.isInteger(repeats) || repeats < 2) {
    throw new Error(`${name}: \`repeats\` must be an integer >= 2 (got ${String(repeats)})`)
  }
  if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) {
    throw new Error(`${name}: \`similarity\` must be a number in [0, 1] (got ${String(similarity)})`)
  }
  if (!Number.isInteger(minChars) || minChars < 0) {
    throw new Error(`${name}: \`minChars\` must be an integer >= 0 (got ${String(minChars)})`)
  }
  if (!Number.isInteger(previewChars) || previewChars < 1) {
    throw new Error(`${name}: \`previewChars\` must be an integer >= 1 (got ${String(previewChars)})`)
  }
  return { repeats, similarity, minChars, action, previewChars }
}

/** Collapse each text block's whitespace and join the non-empty blocks into one normalized round output. */
function normalizeRoundText(texts: string[]): string {
  return texts
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(text => text.length > 0)
    .join('\n')
}

/** The character bigrams of a normalized text, as a set. */
function bigramSet(text: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2))
  return out
}

/**
 * Character-bigram Dice coefficient in [0, 1]: 1 for identical bigram sets,
 * 0 for disjoint ones. Sensitive to a handful of changed characters in long
 * status text (a typo loop), indifferent to ordering of unrelated content.
 */
function diceSimilarity(a: string, b: string): number {
  const setA = bigramSet(a)
  const setB = bigramSet(b)
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  const small = setA.size <= setB.size ? setA : setB
  const large = small === setA ? setB : setA
  let inter = 0
  for (const gram of small) if (large.has(gram)) inter += 1
  return (2 * inter) / (setA.size + setB.size)
}

/**
 * Head-truncate a normalized output for quoting in a log line, marking the
 * omitted length. Bounds only the log text, never the comparison (the streak
 * always keys on the full normalized string).
 */
function preview(text: string, cap: number): string {
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}… (+${text.length - cap} more chars)`
}

/**
 * Install the guard's single session-event listener.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = validate(config)
  const openRounds = new WeakMap<Agent, OpenRound>()
  const streaks = new WeakMap<Agent, Streak>()

  /** Whether a normalized output counts as a repeat of the streak's compared text. */
  function isRepeat(lastText: string, text: string): boolean {
    if (text === lastText) return true
    if (resolved.similarity >= 1) return false
    return diceSimilarity(lastText, text) >= resolved.similarity
  }

  /** One log line per triggered stop, bounded by previewChars. */
  function logStop(agent: Agent, streak: Streak, round: number, outcome: string): void {
    ctx.logger.warn(
      `${name}: agent "${agent.id}" — goal "${streak.goalId}" round ${round} completed with output `
      + `identical to the previous ${streak.count - 1} round(s) (${outcome}); repeated output: ${preview(streak.lastText, resolved.previewChars)}`,
    )
  }

  /** Execute the configured stop exactly once per streak; a failure logs and never re-throws into the session event. */
  function stopGoal(agent: Agent, streak: Streak, round: number): void {
    streak.stopped = true
    try {
      if (resolved.action === 'block') {
        const goal: GoalView | undefined = ctx.goals.get(agent)
        if (goal !== undefined && goal.id === streak.goalId && goal.phase === 'active' && goal.activation === 'armed') {
          ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
            code: BLOCK_CODE,
            message: `Goal stopped automatically after ${streak.count} consecutive rounds with identical output. `
              + 'Review the checkpoint and resume only with new direction.',
          })
          logStop(agent, streak, round, 'blocked')
        }
        return
      }
      ctx.goals.disarm(agent)
      logStop(agent, streak, round, 'disarmed')
    } catch (error: unknown) {
      ctx.logger.warn(
        `${name}: could not stop goal "${streak.goalId}" for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Fold one completed, comparable goal round into the agent's streak, triggering the stop at the threshold. */
  function completeRound(agent: Agent, round: OpenRound): void {
    const text = normalizeRoundText(round.texts)
    if (text.length < resolved.minChars) return
    const current = streaks.get(agent)
    if (current !== undefined
      && current.goalId === round.goalId
      && current.revision === round.revision
      && !current.stopped) {
      if (isRepeat(current.lastText, text)) current.count += 1
      else {
        current.lastText = text
        current.count = 1
      }
    } else {
      streaks.set(agent, { goalId: round.goalId, revision: round.revision, lastText: text, count: 1, stopped: false })
      return
    }
    if (current.count >= resolved.repeats) stopGoal(agent, current, round.round)
  }

  /** Reset one agent's streak: the goal context changed (human prompt, round-0 seed, new goal revision). */
  function resetStreak(agent: Agent): void {
    streaks.delete(agent)
  }

  ctx.on('session/event', (session: Session, event: SessionEvent): void => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source.kind === 'goal' && source.round > 0) {
          openRounds.set(agent, { goalId: source.goalId, revision: source.revision, round: source.round, texts: [] })
          return
        }
        if (source.kind === 'user' || (source.kind === 'goal' && source.round === 0)) {
          // A human prompt — or a goal seed — changes the context: the round in
          // flight (if any) no longer is a pure goal round, and the streak resets.
          openRounds.delete(agent)
          resetStreak(agent)
          return
        }
        // Plugin- and other-sourced context is transparent: neither counts nor resets.
        return
      }
      case 'assistant/message': {
        const open = openRounds.get(agent)
        if (open === undefined) return
        for (const block of event.data.message.content) {
          if (block.type === 'text') open.texts.push(block.text)
        }
        return
      }
      case 'turn/end': {
        const open = openRounds.get(agent)
        if (open === undefined) {
          // A non-goal turn completed (user prompt, plugin work): context changed, streak resets.
          if (event.data.reason.kind === 'completed') resetStreak(agent)
          return
        }
        openRounds.delete(agent)
        if (event.data.reason.kind !== 'completed') return
        // Defer the fold (and the possible stop) out of this event's dispatch:
        // the `action: 'block'` stop commits a `goal/change` event on the same
        // session, and a nested append during `turn/end` dispatch is not
        // re-entrancy-safe. The microtask runs after the append has settled.
        queueMicrotask(() => completeRound(agent, open))
        return
      }
      default:
        return
    }
  })
}
