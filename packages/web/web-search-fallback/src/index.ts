/**
 * Register the DuckDuckGo Lite + Mojeek cascade provider in `ctx.web`. The
 * primary serves DuckDuckGo Lite's fresher index; when it fails — typically a
 * challenge against this deployment's data-center IP — the same request
 * retries on Mojeek. One GET per engine, no credential and no auxiliary model
 * call.
 * @module @deepseek-ai/dsh-web-search-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
} from '@deepseek-ai/dsh-web-search-duckduckgo'
import {
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
} from '@deepseek-ai/dsh-web-search-mojeek'
import { CascadeSearchProvider } from './provider.ts'
import type { CascadeSearchProviderOptions } from './provider.ts'

export {
  CASCADE_PROVIDER_ID,
  CascadeSearchProvider,
} from './provider.ts'
export type { CascadeSearchProviderOptions } from './provider.ts'
export {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_DEFAULT_USER_AGENT,
} from '@deepseek-ai/dsh-web-search-duckduckgo'
export {
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
} from '@deepseek-ai/dsh-web-search-mojeek'

/* jscpd:ignore-start -- standard keyless search-provider plugin shape (name/inject/Config/apply),
   structurally identical across the ctx.web provider family, not an accidental clone */
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-fallback'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills the schema defaults). */
export interface Config {
  /** DuckDuckGo Lite (primary) search page base; the query becomes `?q=` on this URL. */
  duckduckgoBaseURL?: string
  /** DuckDuckGo Lite (primary) `user-agent` header sent with every request. */
  duckduckgoUserAgent?: string
  /** Mojeek (fallback) site base; `/search?q=` is appended. */
  mojeekBaseURL?: string
  /** Mojeek (fallback) `user-agent` header sent with every request. */
  mojeekUserAgent?: string
}

export const Config: z<Config> = z.object({
  duckduckgoBaseURL: z.string().default(DUCKDUCKGO_DEFAULT_BASE_URL),
  duckduckgoUserAgent: z.string().default(DUCKDUCKGO_DEFAULT_USER_AGENT),
  mojeekBaseURL: z.string().default(MOJEEK_DEFAULT_BASE_URL),
  mojeekUserAgent: z.string().default(MOJEEK_DEFAULT_USER_AGENT),
})

/** Register the cascade search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new CascadeSearchProvider((): CascadeSearchProviderOptions => ({
    duckduckgo: {
      baseURL: config.duckduckgoBaseURL ?? DUCKDUCKGO_DEFAULT_BASE_URL,
      userAgent: config.duckduckgoUserAgent ?? DUCKDUCKGO_DEFAULT_USER_AGENT,
    },
    mojeek: {
      baseURL: config.mojeekBaseURL ?? MOJEEK_DEFAULT_BASE_URL,
      userAgent: config.mojeekUserAgent ?? MOJEEK_DEFAULT_USER_AGENT,
    },
  })))
}
/* jscpd:ignore-end */
