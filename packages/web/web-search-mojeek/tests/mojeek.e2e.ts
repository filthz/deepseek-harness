import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { MOJEEK_DEFAULT_BASE_URL, MOJEEK_DEFAULT_USER_AGENT, MojeekSearchProvider } from '../src/provider.ts'
import type { MojeekSearchProviderOptions } from '../src/provider.ts'

/**
 * Real-endpoint smoke for the Mojeek search provider. Like the other
 * keyless scraper suites it needs no credential and therefore never
 * self-skips; Mojeek rate-limits bursts from data-center IPs, so a
 * challenge outcome (after the single backoff retry) is a valid real-world
 * result this suite tolerates.
 */
describe('MojeekSearchProvider real endpoint', () => {
  it('returns direct sources or a challenge error for a live query with spaces', async () => {
    const provider = new MojeekSearchProvider((): MojeekSearchProviderOptions => ({
      baseURL: process.env.MOJEEK_BASE_URL ?? MOJEEK_DEFAULT_BASE_URL,
      userAgent: MOJEEK_DEFAULT_USER_AGENT,
    }))
    try {
      // The query carries spaces on purpose: the URL must be form-encoded
      // (`+`), never `%20`-encoded — the WAF challenges the latter.
      const result = await provider.search({ query: 'deep seek harness', maxResults: 5 })
      expect(result.sources.length).toBeGreaterThan(0)
      for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
    } catch (error) {
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
      expect((error as WebError).message).toMatch(/challenge/i)
    }
  }, 60_000)
})
