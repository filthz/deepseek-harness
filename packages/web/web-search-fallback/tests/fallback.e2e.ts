import { describe, expect, it } from 'vitest'
import {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
  CascadeSearchProvider,
} from '../src/index.ts'
import type { CascadeSearchProviderOptions } from '../src/provider.ts'

/**
 * Real-endpoint smoke for the cascade: DuckDuckGo Lite primary + Mojeek
 * fallback against the live endpoints. Keyless, so the suite never
 * self-skips. A challenged primary is a valid real-world outcome — the
 * fallback then has to deliver, which is still success; a cascade that throws
 * is a failure.
 */
describe('CascadeSearchProvider real endpoints', () => {
  it('returns at least one source for a live query with spaces', async () => {
    const provider = new CascadeSearchProvider((): CascadeSearchProviderOptions => ({
      duckduckgo: {
        baseURL: DUCKDUCKGO_DEFAULT_BASE_URL,
        userAgent: DUCKDUCKGO_DEFAULT_USER_AGENT,
      },
      mojeek: {
        baseURL: MOJEEK_DEFAULT_BASE_URL,
        userAgent: MOJEEK_DEFAULT_USER_AGENT,
      },
    }))
    // The query carries spaces on purpose: the primary percent-encodes it,
    // the fallback form-encodes it — both encodings must reach their endpoint.
    const result = await provider.search({ query: 'deep seek harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 120_000)
})
