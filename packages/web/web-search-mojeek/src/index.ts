/**
 * Register a keyless Mojeek provider in `ctx.web`. One GET to the plain-HTML
 * `/search` endpoint per query, parsed into normalized sources — no
 * credential and no auxiliary model call, the bot-tolerant fallback for
 * data-center IPs that other keyless providers challenge.
 * @module @deepseek-ai/dsh-web-search-mojeek
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
  MojeekSearchProvider,
} from './provider.ts'
import type { MojeekSearchProviderOptions } from './provider.ts'

export {
  MOJEEK_DEFAULT_BASE_URL,
  MOJEEK_DEFAULT_USER_AGENT,
  MOJEEK_PROVIDER_ID,
  MojeekSearchProvider,
  challengeDetection,
  parseResults,
  toPlainText,
} from './provider.ts'
export type { MojeekSearchProviderOptions } from './provider.ts'

/* jscpd:ignore-start -- standard keyless search-provider plugin shape (name/inject/Config/apply),
   structurally identical across the ctx.web provider family, not an accidental clone */
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-mojeek'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills the schema defaults). */
export interface Config {
  /** Mojeek site base (trailing slashes removed); `/search?q=` is appended. */
  baseURL?: string
  /** `user-agent` header sent with every request. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(MOJEEK_DEFAULT_BASE_URL),
  userAgent: z.string().default(MOJEEK_DEFAULT_USER_AGENT),
})

/** Register the Mojeek search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new MojeekSearchProvider((): MojeekSearchProviderOptions => ({
    baseURL: config.baseURL ?? MOJEEK_DEFAULT_BASE_URL,
    userAgent: config.userAgent ?? MOJEEK_DEFAULT_USER_AGENT,
  })))
}
/* jscpd:ignore-end */
