import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
} from '@deepseek-ai/dsh-web-search-duckduckgo'
import {
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
} from '@deepseek-ai/dsh-web-search-mojeek'
import { CASCADE_PROVIDER_ID, CascadeSearchProvider } from '../src/provider.ts'
import type { CascadeSearchProviderOptions } from '../src/provider.ts'
import * as fallbackPlugin from '../src/index.ts'
import { apply, inject, name } from '../src/index.ts'

/**
 * Offline cascade-routing suite: both engines are mocked provider-like
 * objects (the tested standalone plugin's fake-engine pattern), so every
 * check asserts routing policy — never the network.
 */

const engines = vi.hoisted(() => {
  type FakeEngine = {
    calls: number
    resolved: { baseURL: string; userAgent: string } | undefined
    behavior: ((request: { query: string; maxResults?: number }, signal?: AbortSignal) => unknown) | undefined
  }
  return {
    duckduckgo: { calls: 0, resolved: undefined, behavior: undefined } as FakeEngine,
    mojeek: { calls: 0, resolved: undefined, behavior: undefined } as FakeEngine,
  }
})

vi.mock('@deepseek-ai/dsh-web-search-duckduckgo', () => ({
  DUCKDUCKGO_DEFAULT_BASE_URL: 'https://lite.duckduckgo.com/lite/',
  DUCKDUCKGO_DEFAULT_USER_AGENT: 'Mozilla/5.0',
  DuckDuckGoLiteSearchProvider: class {
    readonly id = 'duckduckgo-lite'
    constructor(private readonly resolveOptions: () => { baseURL: string; userAgent: string }) {}
    available(): boolean {
      return true
    }
    async search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<unknown> {
      engines.duckduckgo.calls += 1
      engines.duckduckgo.resolved = this.resolveOptions()
      if (engines.duckduckgo.behavior === undefined) throw new Error('fake DuckDuckGo engine has no behavior')
      return engines.duckduckgo.behavior(request, signal)
    }
  },
}))

vi.mock('@deepseek-ai/dsh-web-search-mojeek', () => ({
  MOJEEK_DEFAULT_BASE_URL: 'https://www.mojeek.com',
  MOJEEK_DEFAULT_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  MojeekSearchProvider: class {
    readonly id = 'mojeek'
    constructor(private readonly resolveOptions: () => { baseURL: string; userAgent: string }) {}
    available(): boolean {
      return true
    }
    async search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<unknown> {
      engines.mojeek.calls += 1
      engines.mojeek.resolved = this.resolveOptions()
      if (engines.mojeek.behavior === undefined) throw new Error('fake Mojeek engine has no behavior')
      return engines.mojeek.behavior(request, signal)
    }
  },
}))

const makeProvider = (
  options?: Partial<{
    duckduckgo: { baseURL?: string; userAgent?: string }
    mojeek: { baseURL?: string; userAgent?: string }
  }>,
): CascadeSearchProvider => new CascadeSearchProvider((): CascadeSearchProviderOptions => ({
  duckduckgo: {
    baseURL: options?.duckduckgo?.baseURL ?? DUCKDUCKGO_DEFAULT_BASE_URL,
    userAgent: options?.duckduckgo?.userAgent ?? DUCKDUCKGO_DEFAULT_USER_AGENT,
  },
  mojeek: {
    baseURL: options?.mojeek?.baseURL ?? MOJEEK_DEFAULT_BASE_URL,
    userAgent: options?.mojeek?.userAgent ?? MOJEEK_DEFAULT_USER_AGENT,
  },
}))

beforeEach(() => {
  for (const engine of [engines.duckduckgo, engines.mojeek]) {
    engine.calls = 0
    engine.resolved = undefined
    engine.behavior = undefined
  }
})

describe('CascadeSearchProvider routing', () => {
  it('exposes the cascade provider id', () => {
    expect(CASCADE_PROVIDER_ID).toBe('duckduckgo-lite-fallback')
    expect(makeProvider().id).toBe(CASCADE_PROVIDER_ID)
  })

  it('returns the primary result when the primary succeeds; the fallback is never called', async () => {
    engines.duckduckgo.behavior = () => ({ sources: [{ url: 'https://p.example' }], truncated: false })
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const result = await makeProvider().search({ query: 'x' })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.url).toBe('https://p.example')
    expect(engines.duckduckgo.calls).toBe(1)
    expect(engines.mojeek.calls).toBe(0)
  })

  it('routes to the fallback when the primary throws WEB_PROVIDER_ERROR (challenge)', async () => {
    engines.duckduckgo.behavior = () => {
      throw new WebError('DuckDuckGo Lite returned a challenge page instead of results; retry later or adjust the query', 'WEB_PROVIDER_ERROR')
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const result = await makeProvider().search({ query: 'x' })
    expect(result.sources[0]?.url).toBe('https://f.example')
    expect(engines.duckduckgo.calls).toBe(1)
    expect(engines.mojeek.calls).toBe(1)
  })

  it('propagates the primary WEB_ABORTED; the fallback is never called', async () => {
    engines.duckduckgo.behavior = () => {
      throw new WebError('DuckDuckGo Lite search aborted', 'WEB_ABORTED')
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    let thrown: unknown
    try {
      await makeProvider().search({ query: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_ABORTED')
    expect(engines.mojeek.calls).toBe(0)
  })

  it('surfaces a raw AbortError from the primary as WEB_ABORTED; the fallback is never called', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    engines.duckduckgo.behavior = () => {
      throw abort
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    let thrown: unknown
    try {
      await makeProvider().search({ query: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_ABORTED')
    expect((thrown as WebError).cause).toBe(abort)
    expect(engines.mojeek.calls).toBe(0)
  })

  it('propagates a caller abort that fires while the primary is in flight', async () => {
    const controller = new AbortController()
    // The engine yields, so the caller's abort lands while the primary is in
    // flight; the cascade's catch then sees the aborted signal.
    engines.duckduckgo.behavior = async () => {
      await Promise.resolve()
      throw new Error('primary in flight')
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const pending = makeProvider().search({ query: 'x' }, controller.signal)
    controller.abort('caller-cancel')
    let thrown: unknown
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_ABORTED')
    expect((thrown as WebError).cause).toBe('caller-cancel')
    expect(engines.mojeek.calls).toBe(0)
  })

  it('routes to the fallback on a generic primary error', async () => {
    engines.duckduckgo.behavior = () => {
      throw new Error('boom')
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const result = await makeProvider().search({ query: 'x' })
    expect(result.sources[0]?.url).toBe('https://f.example')
    expect(engines.mojeek.calls).toBe(1)
  })

  it('returns a valid empty primary result (zero sources); the fallback is never called', async () => {
    engines.duckduckgo.behavior = () => ({ sources: [], truncated: false })
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const result = await makeProvider().search({ query: 'x' })
    expect(result.sources).toHaveLength(0)
    expect(engines.duckduckgo.calls).toBe(1)
    expect(engines.mojeek.calls).toBe(0)
  })

  it('throws WEB_PROVIDER_ERROR naming both engines when both fail; cause is the fallback error', async () => {
    const primaryError = new WebError('DuckDuckGo Lite returned a challenge page instead of results; retry later or adjust the query', 'WEB_PROVIDER_ERROR')
    const fallbackError = new WebError('Mojeek returned a bot challenge (HTTP 429); the endpoint rate-limits bursts from this IP — retry later or switch providers', 'WEB_PROVIDER_ERROR')
    engines.duckduckgo.behavior = () => {
      throw primaryError
    }
    engines.mojeek.behavior = () => {
      throw fallbackError
    }
    let thrown: unknown
    try {
      await makeProvider().search({ query: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((thrown as WebError).message).toContain('DuckDuckGo Lite failed')
    expect((thrown as WebError).message).toContain('Mojeek also failed')
    expect((thrown as WebError).cause).toBe(fallbackError)
  })

  it('reports a non-Error primary failure verbatim in the exhausted-cascade message', async () => {
    engines.duckduckgo.behavior = () => {
      throw 'primary down'
    }
    engines.mojeek.behavior = () => {
      throw new WebError('Mojeek search request failed: fetch failed', 'WEB_PROVIDER_ERROR')
    }
    let thrown: unknown
    try {
      await makeProvider().search({ query: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((thrown as WebError).message).toContain('DuckDuckGo Lite failed (primary down)')
    expect((thrown as WebError).message).toContain('Mojeek also failed')
  })

  it('propagates an abort from the fallback; the exhausted-cascade error is never thrown', async () => {
    const abort = new DOMException('fallback aborted', 'AbortError')
    engines.duckduckgo.behavior = () => {
      throw new Error('boom')
    }
    engines.mojeek.behavior = () => {
      throw abort
    }
    let thrown: unknown
    try {
      await makeProvider().search({ query: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_ABORTED')
    expect((thrown as WebError).cause).toBe(abort)
    expect((thrown as WebError).message).not.toContain('exhausted')
  })
})

describe('CascadeSearchProvider pre-entry abort', () => {
  it('throws WEB_ABORTED for an already-aborted signal before any engine runs', async () => {
    const controller = new AbortController()
    controller.abort('pre-cancelled')
    let thrown: unknown
    try {
      await makeProvider().search({ query: 'x' }, controller.signal)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    expect((thrown as WebError).code).toBe('WEB_ABORTED')
    expect((thrown as WebError).cause).toBe('pre-cancelled')
    expect(engines.duckduckgo.calls).toBe(0)
    expect(engines.mojeek.calls).toBe(0)
  })
})

describe('web-search-fallback plugin registration', () => {
  it('registers the cascade provider into ctx.web (HMR-safe)', async () => {
    engines.duckduckgo.behavior = () => ({ sources: [{ url: 'https://p.example' }], truncated: false })
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: CASCADE_PROVIDER_ID })
    const fiber = await ctx.plugin(fallbackPlugin)
    const result = await ctx.web.search({ query: 'deep seek harness', maxResults: 2 })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.url).toBe('https://p.example')
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('routes through the cascade on a primary failure (real composition)', async () => {
    engines.duckduckgo.behavior = () => {
      throw new WebError('DuckDuckGo Lite returned a challenge page instead of results; retry later or adjust the query', 'WEB_PROVIDER_ERROR')
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: CASCADE_PROVIDER_ID })
    const fiber = await ctx.plugin(fallbackPlugin)
    const result = await ctx.web.search({ query: 'deep seek harness' })
    expect(result.sources[0]?.url).toBe('https://f.example')
    await fiber.dispose()
  })
})

describe('CascadeSearchProvider options', () => {
  it('available() is true when both engine options parse', () => {
    expect(makeProvider().available()).toBe(true)
  })

  it('available() is false for an unparseable primary base URL', () => {
    expect(makeProvider({ duckduckgo: { baseURL: 'not a url' } }).available()).toBe(false)
  })

  it('available() is false for an empty primary user agent', () => {
    expect(makeProvider({ duckduckgo: { userAgent: '' } }).available()).toBe(false)
  })

  it('available() is false for an unparseable fallback base URL', () => {
    expect(makeProvider({ mojeek: { baseURL: 'not a url' } }).available()).toBe(false)
  })

  it('available() is false for an empty fallback user agent', () => {
    expect(makeProvider({ mojeek: { userAgent: '' } }).available()).toBe(false)
  })
})

describe('web-search-fallback plugin entry', () => {
  it('exports the plugin name and the web injection', () => {
    expect(name).toBe('web-search-fallback')
    expect(inject).toEqual(['web'])
  })

  it('apply registers the cascade provider and resolves both engine defaults', async () => {
    let registered: CascadeSearchProvider | undefined
    const ctx = {
      web: {
        registerSearchProvider: (provider: CascadeSearchProvider): (() => void) => {
          registered = provider
          return () => {}
        },
      },
    } as unknown as Context
    apply(ctx, {})
    expect(registered).toBeInstanceOf(CascadeSearchProvider)
    expect(registered?.id).toBe(CASCADE_PROVIDER_ID)
    engines.duckduckgo.behavior = () => {
      throw new WebError('DuckDuckGo Lite search request failed: fetch failed', 'WEB_PROVIDER_ERROR')
    }
    engines.mojeek.behavior = () => ({ sources: [{ url: 'https://f.example' }], truncated: false })
    const result = await registered?.search({ query: 'x' })
    expect(result?.sources[0]?.url).toBe('https://f.example')
    expect(engines.duckduckgo.resolved).toEqual({
      baseURL: DUCKDUCKGO_DEFAULT_BASE_URL,
      userAgent: DUCKDUCKGO_DEFAULT_USER_AGENT,
    })
    expect(engines.mojeek.resolved).toEqual({
      baseURL: MOJEEK_DEFAULT_BASE_URL,
      userAgent: MOJEEK_DEFAULT_USER_AGENT,
    })
  })

  it('apply honors explicit config overrides', async () => {
    let registered: CascadeSearchProvider | undefined
    const ctx = {
      web: {
        registerSearchProvider: (provider: CascadeSearchProvider): (() => void) => {
          registered = provider
          return () => {}
        },
      },
    } as unknown as Context
    apply(ctx, {
      duckduckgoBaseURL: 'https://primary.example/lite/',
      duckduckgoUserAgent: 'primary-ua',
      mojeekBaseURL: 'https://fallback.example',
      mojeekUserAgent: 'fallback-ua',
    })
    engines.duckduckgo.behavior = () => ({ sources: [{ url: 'https://p.example' }], truncated: false })
    const result = await registered?.search({ query: 'x' })
    expect(result?.sources[0]?.url).toBe('https://p.example')
    expect(engines.duckduckgo.resolved).toEqual({
      baseURL: 'https://primary.example/lite/',
      userAgent: 'primary-ua',
    })
  })
})
