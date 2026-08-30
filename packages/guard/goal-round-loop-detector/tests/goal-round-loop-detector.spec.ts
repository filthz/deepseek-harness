import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as goalRoundDriver from '../../../goal/goal-round-driver/src/index.ts'
import * as LoopGuard from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Behavior suite for the goal-round loop detector, driven through a real agent
 * loop with the real goal-round-driver (so rounds auto-continue exactly as in
 * production) against a scripted mock adapter (no network). Covers: default
 * disarm at 3 identical rounds, streak reset on differing output, similarity
 * tolerance (typo loops), the block action, minChars skip, human-interjection
 * reset, and fail-loud config validation.
 */

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Model adapter that computes each response from the call number. */
class ScriptedResponder extends LlmAdapter {
  calls = 0
  constructor(private readonly responder: (call: number) => StreamChunk[]) {
    super()
  }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.responder(this.calls + 1)) yield chunk
    this.calls += 1
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: ScriptedResponder
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount a real loop + goal domain + driver + guard with only the model scripted. */
async function harness(responder: (call: number) => StreamChunk[], config: Config = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(goalRoundDriver)
  await ctx.plugin(LoopGuard, config)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedResponder(responder)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(`loop-guard-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, agent, adapter }
}

/** Poll until the probe returns a defined value or the timeout expires. */
async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Count admitted goal rounds (round > 0) in the agent's log. */
function goalRounds(h: Harness): number {
  return [...h.agent.session.events].filter(event =>
    event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.round > 0,
  ).length
}

/** The long, stable status text a looping agent re-emits each round. */
const STATUS =
  'S4 — Kernel analysis (22 open kernels): 3× "offen (d/f)" (FRI vs. Query → phase_queries.cu), '
  + '6× "offen (a/c/e)" (Setup vs. Tip5 vs. Commitment), 5× "offen (a/e)", 4× "offen (b/g)". '
  + '4096-cap: 336 kernel×architecture slots. SBOX-LUT (L6) remains the only non-writable table. '
  + 'Template: ../cpu-protokoll.md (existing) + zk-pow-miner-backoff flags.'

describe('default action (disarm)', () => {
  it('disarms after 3 consecutive identical rounds and stops the auto-continuation', async () => {
    const h = await harness(() => textResponse(STATUS))
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 8 })

    await until(() => h.ctx.goals.get(h.agent)?.activation === 'disarmed' ? true : undefined, 'goal disarm')
    await sleep(75) // settle: no further round may queue after the stop

    const goal = h.ctx.goals.get(h.agent)
    expect(goal?.phase).toBe('active') // durable phase untouched by disarm
    expect(goal?.activation).toBe('disarmed')
    expect(goalRounds(h)).toBe(3) // rounds 1..3 ran, round 4 never queued
    expect(h.adapter.calls).toBe(3)
  })

  it('a different output resets the streak; the loop resumes counting from one', async () => {
    // A suffix of STATUS would score >= 0.9 bigram Dice (a repeat), so use a
    // genuinely different status, as in the round-cap boundary test below.
    const h = await harness(call => textResponse(call === 3 ? otherText(STATUS) : STATUS))
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 12 })

    // STATUS, STATUS (streak 2), OTHER (reset), STATUS, STATUS, STATUS (streak 3) → stop
    await until(() => h.ctx.goals.get(h.agent)?.activation === 'disarmed' ? true : undefined, 'goal disarm')
    await sleep(75)

    expect(goalRounds(h)).toBe(6)
    expect(h.adapter.calls).toBe(6)
  })

  it('counts a near-identical (typo) round as a repeat at the default similarity 0.9', async () => {
    const typo = STATUS.replace('cpu-protokoll.md', 'cpu-Protokoll.MD')
    const h = await harness(call => textResponse(call === 2 ? typo : STATUS))
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 8 })

    await until(() => h.ctx.goals.get(h.agent)?.activation === 'disarmed' ? true : undefined, 'goal disarm')
    await sleep(75)

    expect(goalRounds(h)).toBe(3)
    expect(h.adapter.calls).toBe(3)
  })

  it('does not stop on genuinely different rounds; the driver round-cap still bounds the run', async () => {
    const h = await harness(call => textResponse(call % 2 === 1 ? STATUS : otherText(STATUS)))
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 4 })

    // The driver blocks the goal at its cap; the guard never triggers.
    await until(() => {
      const goal = h.ctx.goals.get(h.agent)
      return goal?.phase === 'blocked' && goal.blockedReason?.code === 'round-limit' ? true : undefined
    }, 'driver round-limit block')

    expect(goalRounds(h)).toBe(4)
    expect(h.adapter.calls).toBe(4)
  })

  it('skips rounds below minChars; short identical output never triggers', async () => {
    const h = await harness(() => textResponse('ok'))
    h.ctx.goals.create(h.agent, { objective: 'ping', maxGoalRounds: 3 })

    await until(() => {
      const goal = h.ctx.goals.get(h.agent)
      return goal?.phase === 'blocked' && goal.blockedReason?.code === 'round-limit' ? true : undefined
    }, 'driver round-limit block')

    expect(goalRounds(h)).toBe(3)
    expect(h.adapter.calls).toBe(3)
  })

  it('a human prompt between rounds resets the streak', async () => {
    const h = await harness(call => textResponse(call === 3 ? 'Understood, checking the dump.' : STATUS))
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 12 })

    // Two identical rounds (streak 2), then the human interjection, then three more.
    await until(() => goalRounds(h) >= 2, 'two goal rounds')
    await h.agent.whenIdle()
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'check in' }], source: { kind: 'user' } }))

    await until(() => h.ctx.goals.get(h.agent)?.activation === 'disarmed' ? true : undefined, 'goal disarm')
    await sleep(75)

    // Rounds 1-2 (streak 2) + user turn + rounds 3-5 (fresh streak 3) → stop.
    expect(goalRounds(h)).toBe(5)
    expect(h.adapter.calls).toBe(6)
  })
})

describe('action: block', () => {
  it('blocks the goal durably with the goal-round-loop reason after 3 identical rounds', async () => {
    const h = await harness(() => textResponse(STATUS), { action: 'block' })
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 8 })

    await until(() => {
      const goal = h.ctx.goals.get(h.agent)
      return goal?.phase === 'blocked' && goal.blockedReason?.code === 'goal-round-loop' ? true : undefined
    }, 'goal block')
    await sleep(75)

    const goal = h.ctx.goals.get(h.agent)
    expect(goal?.activation).toBe('disarmed')
    expect(goal?.blockedReason?.message).toContain('3 consecutive rounds')
    expect(goalRounds(h)).toBe(3)
    expect(h.adapter.calls).toBe(3)
  })

  it('obeys a custom repeats threshold (2) when configured', async () => {
    const h = await harness(() => textResponse(STATUS), { repeats: 2 })
    h.ctx.goals.create(h.agent, { objective: 'finish the kernel port', maxGoalRounds: 8 })

    await until(() => h.ctx.goals.get(h.agent)?.activation === 'disarmed' ? true : undefined, 'goal disarm')
    await sleep(75)

    expect(goalRounds(h)).toBe(2)
    expect(h.adapter.calls).toBe(2)
  })
})

/** A genuinely different status with the same length scale. */
function otherText(base: string): string {
  return base.replace('Kernel analysis (22 open kernels)', 'Kernel analysis (40 closed kernels)')
    .replace('phase_queries.cu', 'phase_commit.cu')
    .replace('336 kernel×architecture slots', '300 kernel×architecture slots')
    .replace('SBOX-LUT (L6) remains the only non-writable table', 'SBOX-LUT (L6) has been dumped and verified')
    .replace('cpu-protokoll.md (existing)', 'gpu-protokoll.md (new)')
}

describe('config validation', () => {
  /**
   * The same agent-loop spine the behavior tests mount, plus the goal service:
   * the guard injects `goals`, and a plugin load only applies (and can reject)
   * once every injected dependency is mounted.
   */
  async function spine(): Promise<Context> {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(GoalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('fails loud on invalid configuration at plugin load', async () => {
    for (const bad of [
      { repeats: 1 },
      { repeats: 2.5 },
      { similarity: 1.5 },
      { similarity: -0.1 },
      { minChars: -1 },
      { previewChars: 0 },
    ]) {
      await expect((await spine()).plugin(LoopGuard, bad)).rejects.toThrow(/goal-round-loop-detector/)
    }
  })
})
