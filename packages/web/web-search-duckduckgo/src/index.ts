/**
 * Register a keyless DuckDuckGo Lite provider in `ctx.web`. One GET to the
 * Lite search page per query, parsed into normalized sources — no credential
 * and no auxiliary model call, the free counterpart of the DeepSeek provider.
 * @module @deepseek-ai/dsh-web-search-duckduckgo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
  DuckDuckGoLiteSearchProvider,
} from './provider.ts'
import type { DuckDuckGoLiteSearchProviderOptions } from './provider.ts'

export {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
  DUCKDUCKGO_LITE_PROVIDER_ID,
  DuckDuckGoLiteSearchProvider,
  challengeDetection,
  decodeResultUrl,
  parseLiteResults,
  stripTags,
} from './provider.ts'
export type { DuckDuckGoLiteSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-duckduckgo'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills the schema defaults). */
export interface Config {
  /** Lite search page base; the query becomes `?q=` on this URL. */
  baseURL?: string
  /** `user-agent` header sent with every request. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DUCKDUCKGO_DEFAULT_BASE_URL),
  userAgent: z.string().default(DUCKDUCKGO_DEFAULT_USER_AGENT),
})

/** Register the DuckDuckGo Lite search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DuckDuckGoLiteSearchProvider((): DuckDuckGoLiteSearchProviderOptions => ({
    baseURL: config.baseURL ?? DUCKDUCKGO_DEFAULT_BASE_URL,
    userAgent: config.userAgent ?? DUCKDUCKGO_DEFAULT_USER_AGENT,
  })))
}
