/**
 * Cascade search provider for the DeepSeek Harness web capability seam
 * (`ctx.web`): DuckDuckGo Lite first for index quality and freshness, Mojeek
 * as the reliability fallback for data-center IPs that DDG challenges. The
 * web seam supports exactly one provider per selection — there is no built-in
 * chain — so the fallback lives here, inside a single provider that
 * instantiates both engines itself (one pair per operation, from a fresh
 * options snapshot) and routes the request between them. No credential, no
 * key, no dedicated API.
 *
 * Cascade policy (fixed, not config):
 * - A caller abort — the signal already aborted, a raw fetch `AbortError`, or
 *   a primary `WEB_ABORTED` — is propagated immediately: never swallowed,
 *   never retried, never masked by the fallback.
 * - Any other primary failure (challenge, network, HTTP, timeout) triggers
 *   the fallback with the same request and signal. While DDG rate-limits a
 *   data-center IP the challenge answer arrives fast, so the fallback cost is
 *   one short round trip.
 * - A genuinely empty primary result (valid response, zero sources) is
 *   returned as-is — each engine has its own index.
 * - A fallback failure throws `WEB_PROVIDER_ERROR` whose message names both
 *   engines and whose `cause` is the fallback error (the primary error is
 *   included in the message).
 * @module @deepseek-ai/dsh-web-search-fallback/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web'
import { DuckDuckGoLiteSearchProvider } from '@deepseek-ai/dsh-web-search-duckduckgo'
import type { DuckDuckGoLiteSearchProviderOptions } from '@deepseek-ai/dsh-web-search-duckduckgo'
import { MojeekSearchProvider } from '@deepseek-ai/dsh-web-search-mojeek'
import type { MojeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-mojeek'

/** Stable id this provider registers under. */
export const CASCADE_PROVIDER_ID = 'duckduckgo-lite-fallback'

/** Resolved provider options (the plugin's `apply` fills schema defaults). */
export interface CascadeSearchProviderOptions {
  /** DuckDuckGo Lite (primary) engine options. */
  duckduckgo: {
    /** Lite search page base; the query becomes `?q=` on this URL. */
    baseURL: string
    /** `user-agent` header sent with every request. */
    userAgent: string
  }
  /** Mojeek (fallback) engine options. */
  mojeek: {
    /** Mojeek site base; `/search?q=` is appended. */
    baseURL: string
    /** `user-agent` header sent with every request. */
    userAgent: string
  }
}

/** The DuckDuckGo Lite + Mojeek cascade search provider; engine failures follow the module's cascade policy. */
export class CascadeSearchProvider implements WebSearchProvider {
  readonly id = CASCADE_PROVIDER_ID

  /* jscpd:ignore-start -- keyless search-provider dispatch preamble (options snapshot + engine wiring),
     structurally identical across the ctx.web provider family, not an accidental clone */
  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections.
   */
  constructor(private readonly resolveOptions: () => CascadeSearchProviderOptions) {}

  /** Usable when both engine options parse: the primary must route and the fallback must be ready. */
  available(): boolean {
    const options = this.resolveOptions()
    const primaryReady = URL.canParse(options.duckduckgo.baseURL) && options.duckduckgo.userAgent.length > 0
    const fallbackReady = URL.canParse(options.mojeek.baseURL) && options.mojeek.userAgent.length > 0
    return primaryReady && fallbackReady
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfSearchAborted(signal)
    const options = this.resolveOptions()
    const primary = new DuckDuckGoLiteSearchProvider((): DuckDuckGoLiteSearchProviderOptions => ({
      baseURL: options.duckduckgo.baseURL,
      userAgent: options.duckduckgo.userAgent,
    }))
    /* jscpd:ignore-end */
    let primaryError: unknown
    try {
      return await primary.search(request, signal)
    } catch (error: unknown) {
      if (isSearchAborted(signal, error)) throw searchAborted(signal, error)
      primaryError = error
    }
    const fallback = new MojeekSearchProvider((): MojeekSearchProviderOptions => ({
      baseURL: options.mojeek.baseURL,
      userAgent: options.mojeek.userAgent,
    }))
    try {
      return await fallback.search(request, signal)
    } catch (fallbackError: unknown) {
      if (isSearchAborted(signal, fallbackError)) throw searchAborted(signal, fallbackError)
      throw new WebError(
        `search fallback exhausted: DuckDuckGo Lite failed (${errorText(primaryError)}); Mojeek also failed (${errorText(fallbackError)})`,
        'WEB_PROVIDER_ERROR',
        { cause: fallbackError },
      )
    }
  }
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
/* jscpd:ignore-start -- stable cancellation helpers, identical across the ctx.web provider family
   (only the engine name in the message differs), not an accidental clone */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('search fallback aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for an engine's stable cancellation error, surfaced as `WEB_ABORTED`. */
function isAbortedWebError(error: unknown): boolean {
  return error instanceof WebError && error.code === 'WEB_ABORTED'
}

/** True when the operation must stop as `WEB_ABORTED`: caller aborted, a raw fetch abort, or an engine cancellation. */
function isSearchAborted(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || isAbortError(error) || isAbortedWebError(error)
}

/** The display text of one engine error for the exhausted-cascade message. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* jscpd:ignore-end */
